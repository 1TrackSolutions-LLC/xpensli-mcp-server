#!/usr/bin/env node
/**
 * @xpensli/mcp-server — exposes the xpensli agent API as MCP tools over stdio.
 *
 * The server holds the paying wallet locally and settles a USDC micropayment
 * (x402) for each paid tool call. Configure it via environment variables; see
 * the README for Claude Desktop and Cursor config blocks.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { buildPayFetch, unconfiguredPayFetch } from "./payment.js";
import { createClient, type FetchLike } from "./client.js";
import { registerTools } from "./tools.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // Build the x402 payer up front when a wallet is configured (createSigner is
  // local, no network). Without a key, paid tools fail with a clear message but
  // the free provision tool still works.
  const payFetch: FetchLike = config.privateKey
    ? await buildPayFetch(config)
    : unconfiguredPayFetch();

  const client = createClient({
    baseUrl: config.baseUrl,
    accountId: config.accountId,
    plainFetch: ((input, init) => fetch(input, init)) as FetchLike,
    payFetch,
  });

  const server = new McpServer({ name: "xpensli", version: "0.1.0" });
  registerTools(server, client);

  await server.connect(new StdioServerTransport());
  // stdout is the JSON-RPC channel — all human logging must go to stderr.
  console.error(
    `xpensli MCP server ready — network=${config.network}, baseUrl=${config.baseUrl}, account=${config.accountId ?? "unset"}, wallet=${config.privateKey ? "configured" : "MISSING (paid tools disabled)"}.`,
  );
}

main().catch((err) => {
  console.error("xpensli MCP server failed to start:", err);
  process.exit(1);
});
