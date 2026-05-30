/**
 * Configuration for the xpensli MCP server, read from environment variables.
 *
 * The server is the x402 *client* — it holds the paying wallet locally and
 * settles a USDC micropayment for each paid tool call. Nothing is sent to
 * xpensli except the agent API requests themselves; the private key never
 * leaves the machine the server runs on.
 */

export interface XpensliConfig {
  /** Agent API origin, e.g. https://xpensli.app (no trailing slash). */
  baseUrl: string;
  /** Provisioned agent account id (acc_…). Null until the user provisions one. */
  accountId: string | null;
  /** x402 settlement network: 'base' (mainnet) or 'base-sepolia' (testnet). */
  network: string;
  /** 0x-prefixed paying wallet key. Null disables paid tools (provision still works). */
  privateKey: string | null;
  /** Hard per-call ceiling in USDC — the x402 client refuses to overpay. */
  maxUsdcPerCall: number;
}

const DEFAULT_BASE_URL = "https://xpensli.app";
const DEFAULT_NETWORK = "base";
const DEFAULT_MAX_USDC = 1;

/**
 * Parse and normalize config from `env`. Coinbase Wallet exports the raw
 * 64-char hex without a 0x prefix; viem's signer requires it, so we add it.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): XpensliConfig {
  const baseUrl = (env.XPENSLI_BASE_URL ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  const accountId = env.XPENSLI_ACCOUNT_ID?.trim() || null;
  const network = (env.XPENSLI_NETWORK ?? DEFAULT_NETWORK).trim().toLowerCase();

  const rawKey = env.XPENSLI_WALLET_PRIVATE_KEY?.trim();
  const privateKey = rawKey ? (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) : null;

  const maxRaw = Number(env.XPENSLI_MAX_USDC_PER_CALL ?? String(DEFAULT_MAX_USDC));
  const maxUsdcPerCall = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : DEFAULT_MAX_USDC;

  return { baseUrl, accountId, network, privateKey, maxUsdcPerCall };
}
