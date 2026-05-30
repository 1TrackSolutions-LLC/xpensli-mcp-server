/**
 * Live smoke test — exercises the real x402 payment path against a deployed
 * xpensli. Intended for base-sepolia (testnet USDC) so it costs nothing real.
 *
 * Run (testnet, against the develop preview):
 *   XPENSLI_BASE_URL=https://xpensli-git-develop-eforks-projects.vercel.app \
 *   XPENSLI_NETWORK=base-sepolia \
 *   XPENSLI_ACCOUNT_ID=acc_… \
 *   XPENSLI_WALLET_PRIVATE_KEY=0x… \
 *   VERCEL_BYPASS_SECRET=…            # only needed for protected preview deploys
 *   npm run smoke
 *
 * This is a dev utility, not shipped in the published package.
 */
import { loadConfig } from "../src/config.js";
import { buildPayFetch, unconfiguredPayFetch } from "../src/payment.js";
import { createClient, type FetchLike } from "../src/client.js";

const BYPASS = process.env.VERCEL_BYPASS_SECRET;

/** Wrap a fetch to append the Vercel deployment-protection bypass (preview only). */
function withBypass(base: typeof fetch): typeof fetch {
  if (!BYPASS) return base;
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    url.searchParams.set("x-vercel-protection-bypass", BYPASS);
    url.searchParams.set("x-vercel-set-bypass-cookie", "true");
    return base(url.toString(), {
      ...init,
      headers: { ...(init?.headers ?? {}), "x-vercel-protection-bypass": BYPASS },
    });
  }) as typeof fetch;
}

async function main(): Promise<void> {
  const config = loadConfig();
  console.error("[smoke] config:", {
    baseUrl: config.baseUrl,
    network: config.network,
    account: config.accountId ?? "unset",
    wallet: config.privateKey ? "set" : "MISSING",
    maxUsdcPerCall: config.maxUsdcPerCall,
    bypass: BYPASS ? "on" : "off",
  });

  const baseFetch = withBypass(fetch);
  const payFetch = config.privateKey ? await buildPayFetch(config, baseFetch) : unconfiguredPayFetch();
  const client = createClient({
    baseUrl: config.baseUrl,
    accountId: config.accountId,
    plainFetch: ((input, init) => baseFetch(input as string, init)) as FetchLike,
    payFetch,
  });

  console.error("\n[smoke] calling xpensli_query_expenses (paid)…");
  const r = await client.query({ query: "How much did I spend on meals this year?" });
  console.error(`[smoke] settlementTx: ${r.settlementTx ?? "(none)"}`);
  console.error("[smoke] response:");
  console.log(JSON.stringify(r.data, null, 2));
  console.error("\n[smoke] ✓ paid round-trip succeeded.");
}

main().catch((err) => {
  console.error("[smoke] ✗ failed:", err);
  process.exit(1);
});
