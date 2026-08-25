# @xpensli/mcp-server

MCP server for [xpensli](https://xpensli.app) — pay-per-call expense tools for AI agents, settled with [x402](https://www.x402.org) USDC micropayments on Base.

It exposes the xpensli agent API as MCP tools: process receipts, query expenses, and generate Schedule C reports. The server runs **locally** and holds your paying wallet — each paid tool call signs a USDC micropayment and settles on-chain. No API keys, no subscription.

> Your wallet private key never leaves your machine. It is used only to sign x402 payment authorizations for the agent API calls you make.

## Tools

| Tool | Cost (USDC) | What it does |
|------|-------------|--------------|
| `xpensli_provision_account` | Free | Create an agent account linked to an xpensli user; returns a `setup_url` for one-time Gmail authorization. Onboarding only. |
| `xpensli_process_receipt` | ~$0.05 | Extract & file a receipt (vendor, amount, date, Schedule C category) from a local file or public URL. |
| `xpensli_query_expenses` | ~$0.02 | Answer a natural-language question about tracked expenses. |
| `xpensli_monthly_report` | ~$0.10 | Monthly summary by category with deductible totals. |
| `xpensli_annual_report` | ~$0.25 | Full-year Schedule C breakdown + downloadable CSV. |
| `xpensli_export_csv` | ~$0.05 | Export receipts in a date range as a signed-URL CSV. |

Prices are advertised live in each x402 `402` challenge; `XPENSLI_MAX_USDC_PER_CALL` is a hard ceiling your wallet will never exceed.

## Prerequisites

1. **An xpensli account.** The agent account links to an existing xpensli user by email.
2. **A provisioned `account_id`.** Run `xpensli_provision_account` once, have the user open the returned `setup_url` to authorize Gmail, then put the `account_id` in your config.
3. **A funded wallet on Base.** A `0x`-prefixed private key holding USDC on Base mainnet (`base`). For testing, use `base-sepolia` with testnet USDC from [faucet.circle.com](https://faucet.circle.com).

## Configuration

All configuration is via environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `XPENSLI_ACCOUNT_ID` | for paid tools | — | Provisioned agent account (`acc_…`). |
| `XPENSLI_WALLET_PRIVATE_KEY` | for paid tools | — | `0x`-prefixed key of the paying wallet (held locally). |
| `XPENSLI_NETWORK` | no | `base` | `base` (mainnet) or `base-sepolia` (testnet). |
| `XPENSLI_MAX_USDC_PER_CALL` | no | `1` | Hard per-call spend ceiling in USDC. |
| `XPENSLI_BASE_URL` | no | `https://xpensli.app` | Agent API origin (override for testing). |

### Claude Desktop

Edit `claude_desktop_config.json`:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "xpensli": {
      "command": "npx",
      "args": ["-y", "@xpensli/mcp-server"],
      "env": {
        "XPENSLI_ACCOUNT_ID": "acc_your_account_id",
        "XPENSLI_WALLET_PRIVATE_KEY": "0xyour_funded_wallet_private_key",
        "XPENSLI_NETWORK": "base",
        "XPENSLI_MAX_USDC_PER_CALL": "1",
        "XPENSLI_BASE_URL": "https://xpensli.app"
      }
    }
  }
}
```

Restart Claude Desktop. The six `xpensli_*` tools appear in the tools menu.

### Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project):

```json
{
  "mcpServers": {
    "xpensli": {
      "command": "npx",
      "args": ["-y", "@xpensli/mcp-server"],
      "env": {
        "XPENSLI_ACCOUNT_ID": "acc_your_account_id",
        "XPENSLI_WALLET_PRIVATE_KEY": "0xyour_funded_wallet_private_key",
        "XPENSLI_NETWORK": "base",
        "XPENSLI_MAX_USDC_PER_CALL": "1",
        "XPENSLI_BASE_URL": "https://xpensli.app"
      }
    }
  }
}
```

Then enable the **xpensli** server in Cursor → Settings → MCP.

## How payment works

Each paid tool call:

1. Hits the xpensli agent API, which replies `402 Payment Required` with an x402 challenge (network, USDC asset, amount).
2. The server signs a USDC authorization (≤ `XPENSLI_MAX_USDC_PER_CALL`) with your wallet and retries.
3. xpensli verifies, settles on Base, runs the work, and returns the result. The settlement transaction hash is included in the tool output.

If the account isn't linked yet, paid tools return the `setup_url` to present to the user.

## Development

```bash
npm install
npm run build      # tsc → dist/
npm test           # unit tests (mocked payments)
npm run smoke      # live testnet round-trip (reads XPENSLI_* from env; see scripts/smoke.ts)
```

## License

MIT © 1Track Solutions LLC
