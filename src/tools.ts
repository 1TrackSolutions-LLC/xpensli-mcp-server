/**
 * Registers the six xpensli tools on an MCP server. Result/error formatting and
 * image resolution are factored into exported helpers so they can be unit-tested
 * without spinning up the MCP transport.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { XpensliApiError, type CallResult, type XpensliClient } from "./client.js";

/** Render a successful call as text, appending the settlement tx when present. */
export function formatResult(result: CallResult): CallToolResult {
  const parts = [JSON.stringify(result.data, null, 2)];
  if (result.settlementTx) {
    parts.push(`\n[paid — settled on Base, tx ${result.settlementTx}]`);
  }
  return { content: [{ type: "text", text: parts.join("\n") }] };
}

/** Map any thrown error to a clear, agent-actionable tool error. */
export function formatError(err: unknown): CallToolResult {
  if (err instanceof XpensliApiError) {
    if (err.status === 403 && err.setupUrl) {
      return {
        content: [
          {
            type: "text",
            text:
              `This agent account isn't linked to an xpensli user yet. Ask the user to finish ` +
              `Gmail authorization here, then retry:\n${err.setupUrl}\n\n` +
              `(You only need this because an account_id is configured. Removing XPENSLI_ACCOUNT_ID ` +
              `bills the wallet's own tenant instead, which needs no setup.)`,
          },
        ],
        isError: true,
      };
    }
    // The one response an agent reliably mishandles: the work SUCCEEDED, the
    // payment did not settle, so nothing was charged and no result came back.
    // Left to the generic branch an agent reads "402" and pays more, which is
    // exactly wrong — it needs a fresh authorization, not a bigger one.
    if (err.code === "settlement_failed") {
      return {
        content: [
          {
            type: "text",
            text:
              "The request was processed but payment settlement failed, so you were NOT charged " +
              "and no result was returned. Retry with a fresh payment authorization. Do not increase " +
              "the amount — the price is unchanged.",
          },
        ],
        isError: true,
      };
    }
    // Lead with the stable code — it is what an agent should branch on.
    const code = err.code ? `${err.code} ` : "";
    return {
      content: [
        {
          type: "text",
          text: `xpensli API error (${code}HTTP ${err.status}): ${JSON.stringify(err.body)}`,
        },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
    isError: true,
  };
}

/**
 * Resolve a process-receipt image argument into the payload the API expects.
 * Exactly one of image_path (read from local disk, base64-encoded) or image_url
 * (a public URL the server fetches) must be provided.
 */
export async function resolveImage(args: {
  image_path?: string;
  image_url?: string;
}): Promise<{ imageBase64?: string; imageUrl?: string }> {
  const hasPath = Boolean(args.image_path);
  const hasUrl = Boolean(args.image_url);
  if (hasPath === hasUrl) {
    throw new Error("Provide exactly one of image_path (local file) or image_url (public URL).");
  }
  if (hasPath) {
    const buf = await readFile(args.image_path as string);
    return { imageBase64: buf.toString("base64") };
  }
  return { imageUrl: args.image_url };
}

/** Wrap an async producer so any throw becomes a formatted tool error. */
async function guarded(produce: () => Promise<CallResult>): Promise<CallToolResult> {
  try {
    return formatResult(await produce());
  } catch (err) {
    return formatError(err);
  }
}

export function registerTools(server: McpServer, client: XpensliClient): void {
  // Registered first deliberately: it is the only tool that needs no account,
  // no setup and (within the daily free allowance) no payment, so it is the one
  // an agent can actually try on first contact.
  server.tool(
    "xpensli_categorize_receipt",
    "Extract and categorize one receipt WITHOUT filing it — returns vendor, amount, date, and Schedule C category. Nothing is stored. Costs ~$0.04 USDC, and the first few calls per day are free. Needs no account and no setup, so this is the one to try first. Provide exactly one of image_path (a local file, read and uploaded for you) or image_url (a public URL).",
    {
      image_path: z.string().optional().describe("Absolute path to a local receipt image (JPEG/PNG/WebP/GIF, ≤10MB)."),
      image_url: z.string().url().optional().describe("Public URL of a receipt image."),
      context: z.string().optional().describe("Optional hint, e.g. 'Client lunch'."),
    },
    async (args) =>
      guarded(async () => {
        const image = await resolveImage(args);
        return client.categorize({ ...image, context: args.context });
      }),
  );

  server.tool(
    "xpensli_provision_account",
    "OPTIONAL — link this agent to an EXISTING xpensli user's account, so receipts file into that person's account rather than the wallet's own. Free. Returns an account_id and a setup_url the user must open to authorize Gmail. You do NOT need this to use the paid tools: with no account configured, the paying wallet is its own tenant and everything works immediately.",
    {
      user_email: z.string().email().describe("Email of the existing xpensli user to link to."),
      agent_id: z.string().min(1).describe("A stable identifier for this agent, e.g. 'my-bookkeeper'."),
      scopes: z.array(z.string()).optional().describe("Optional scopes, e.g. ['read','write']."),
    },
    (args) =>
      guarded(() =>
        client.provision({ userEmail: args.user_email, agentId: args.agent_id, scopes: args.scopes }),
      ),
  );

  server.tool(
    "xpensli_process_receipt",
    "Extract and FILE one receipt, keeping it on the books — returns vendor, amount, date, and Schedule C category. Costs ~$0.05 USDC, settled on Base. Files into the linked user's account when one is configured, otherwise into the paying wallet's own account. Provide exactly one of image_path (a local file, read and uploaded for you) or image_url (a public URL). A receipt that looks like a duplicate of one already on file is returned as NEEDS_REVIEW rather than auto-filed. Use xpensli_categorize_receipt instead if you only want the data and do not want it stored.",
    {
      image_path: z.string().optional().describe("Absolute path to a local receipt image (JPEG/PNG/WebP/GIF, ≤10MB)."),
      image_url: z.string().url().optional().describe("Public URL of a receipt image."),
      context: z.string().optional().describe("Optional note attached to the receipt, e.g. 'Client lunch'."),
    },
    async (args) =>
      guarded(async () => {
        const image = await resolveImage(args);
        return client.processReceipt({ ...image, context: args.context });
      }),
  );

  server.tool(
    "xpensli_query_expenses",
    "Answer a natural-language question about the user's tracked expenses (e.g. 'How much did I spend on meals this year?'). Costs ~$0.02 USDC, settled on Base.",
    {
      query: z.string().min(1).describe("The natural-language question about expenses."),
    },
    (args) => guarded(() => client.query({ query: args.query })),
  );

  server.tool(
    "xpensli_monthly_report",
    "Generate a monthly expense summary by category with deductible totals. Costs ~$0.10 USDC, settled on Base. 'month' is YYYY-MM; omit it to use the previous calendar month.",
    {
      month: z
        .string()
        .regex(/^\d{4}-\d{2}$/, "month must be YYYY-MM")
        .optional()
        .describe("Target month as YYYY-MM. Defaults to last month."),
    },
    (args) => guarded(() => client.monthlyReport({ month: args.month })),
  );

  server.tool(
    "xpensli_annual_report",
    "Generate a full-year Schedule C breakdown plus a downloadable CSV. Costs ~$0.25 USDC, settled on Base. 'year' is YYYY; omit it to use the current year.",
    {
      year: z
        .string()
        .regex(/^\d{4}$/, "year must be YYYY")
        .optional()
        .describe("Target year as YYYY. Defaults to the current year."),
    },
    (args) => guarded(() => client.annualReport({ year: args.year })),
  );

  server.tool(
    "xpensli_export_csv",
    "Export receipts in a date range as a signed-URL CSV (expires in 1 hour). Costs ~$0.05 USDC, settled on Base. 'start' and 'end' are YYYY-MM-DD.",
    {
      start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "start must be YYYY-MM-DD").describe("Range start (YYYY-MM-DD)."),
      end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "end must be YYYY-MM-DD").describe("Range end (YYYY-MM-DD)."),
    },
    (args) => guarded(() => client.exportCsv({ start: args.start, end: args.end })),
  );
}
