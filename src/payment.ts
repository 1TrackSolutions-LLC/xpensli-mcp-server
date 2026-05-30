/**
 * Builds the x402-paying fetch from the configured wallet. Kept separate from
 * `client.ts` so the request logic stays pure and testable; this module is the
 * only place that touches the wallet and the x402 protocol.
 */
import { wrapFetchWithPayment, createSigner } from "x402-fetch";
import type { XpensliConfig } from "./config.js";
import type { FetchLike } from "./client.js";

/** USDC has 6 decimals. */
const USDC_DECIMALS = 1_000_000;

/**
 * An x402-wrapped fetch that signs a USDC authorization (up to the per-call
 * ceiling) and settles on the configured network. Throws if no wallet key is
 * configured — paid tools surface that as an actionable error.
 */
export async function buildPayFetch(
  config: XpensliConfig,
  baseFetch: typeof fetch = fetch,
): Promise<FetchLike> {
  if (!config.privateKey) {
    throw new Error(
      "XPENSLI_WALLET_PRIVATE_KEY is not set — it is required to pay for this tool. Add a funded wallet key to the server config.",
    );
  }
  const signer = await createSigner(config.network, config.privateKey);
  const maxValue = BigInt(Math.round(config.maxUsdcPerCall * USDC_DECIMALS));
  const wrapped = wrapFetchWithPayment(baseFetch, signer, maxValue);
  return wrapped as unknown as FetchLike;
}

/** A payFetch stand-in used when no wallet is configured; every call explains the gap. */
export function unconfiguredPayFetch(): FetchLike {
  return async () => {
    throw new Error(
      "XPENSLI_WALLET_PRIVATE_KEY is not set — this tool costs USDC and needs a funded wallet. Add the key to the server config to enable paid tools.",
    );
  };
}
