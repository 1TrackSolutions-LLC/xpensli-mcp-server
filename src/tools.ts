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
            text: `This agent account isn't linked to an xpensli user yet. Ask the user to finish Gmail authorization here, then retry:\n${err.setupUrl}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `xpensli API error (HTTP ${err.status}): ${JSON.stringify(err.body)}`,
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
  server.tool(
    "xpensli_provision_account",
    "Create an xpensli agent account linked to an existing xpensli user (matched by email). Free — no payment. Returns an account_id and a setup_url; the user must open the setup_url to authorize Gmail before any paid tool will work. Onboarding only — usually you set the resulting account_id in the server config and never call this again.",
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
    "Extract and file one receipt — returns vendor, amount, date, and Schedule C category. Costs ~$0.05 USDC, settled on Base. Provide exactly one of image_path (a local file, read and uploaded for you) or image_url (a public URL). A receipt that looks like a duplicate of one already on file is returned as NEEDS_REVIEW rather than auto-filed.",
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
