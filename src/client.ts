/**
 * Thin typed client over the xpensli agent HTTP API.
 *
 * Payment is injected, not built here: `payFetch` is an x402-wrapped fetch
 * that settles a USDC micropayment per request, while `plainFetch` is a normal
 * fetch used for the free `provision` endpoint. Injecting both keeps this
 * module pure and unit-testable with mocked payments.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientDeps {
  baseUrl: string;
  accountId: string | null;
  /** Used for free endpoints (provision). */
  plainFetch: FetchLike;
  /** x402-wrapped fetch used for paid endpoints. */
  payFetch: FetchLike;
}

/** Error carrying the HTTP status and parsed body of a failed agent API call. */
export class XpensliApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `xpensli API error (HTTP ${status})`);
    this.name = "XpensliApiError";
  }

  /** `setup_url` from a 403 (account-not-linked) body, when present. */
  get setupUrl(): string | null {
    const b = this.body as { setup_url?: unknown } | null;
    return b && typeof b.setup_url === "string" ? b.setup_url : null;
  }
}

export interface CallResult<T = unknown> {
  data: T;
  /** On-chain settlement tx hash from the X-PAYMENT-RESPONSE header, if any. */
  settlementTx: string | null;
}

function extractSettlementTx(res: Response): string | null {
  const header = res.headers.get("x-payment-response");
  if (!header) return null;
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      transaction?: unknown;
    };
    return typeof decoded.transaction === "string" ? decoded.transaction : null;
  } catch {
    return null;
  }
}

interface CallOpts {
  body?: unknown;
  query?: Record<string, string | number | null | undefined>;
}

async function call<T>(
  fetcher: FetchLike,
  baseUrl: string,
  method: "GET" | "POST",
  path: string,
  opts: CallOpts = {},
): Promise<CallResult<T>> {
  const url = new URL(baseUrl + path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== null && v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

  const res = await fetcher(url.toString(), init);
  const data = (await res.json().catch(() => ({}))) as T;
  if (!res.ok) {
    throw new XpensliApiError(res.status, data);
  }
  return { data, settlementTx: extractSettlementTx(res) };
}

export interface XpensliClient {
  provision(args: {
    userEmail: string;
    agentId: string;
    scopes?: string[];
  }): Promise<CallResult>;
  processReceipt(args: {
    imageBase64?: string;
    imageUrl?: string;
    context?: string;
  }): Promise<CallResult>;
  query(args: { query: string }): Promise<CallResult>;
  monthlyReport(args: { month?: string }): Promise<CallResult>;
  annualReport(args: { year?: string }): Promise<CallResult>;
  exportCsv(args: { start: string; end: string }): Promise<CallResult>;
}

export function createClient(deps: ClientDeps): XpensliClient {
  const { baseUrl, accountId, plainFetch, payFetch } = deps;

  const requireAccount = (): string => {
    if (!accountId) {
      throw new Error(
        "XPENSLI_ACCOUNT_ID is not set. Provision an account first (xpensli_provision_account) and set the returned account_id in this server's config.",
      );
    }
    return accountId;
  };

  // Methods are async so a synchronous requireAccount() failure surfaces as a
  // rejected promise rather than a throw during argument evaluation.
  return {
    provision: async ({ userEmail, agentId, scopes }) =>
      call(plainFetch, baseUrl, "POST", "/api/agent/provision", {
        body: { user_email: userEmail, agent_id: agentId, scopes },
      }),

    processReceipt: async ({ imageBase64, imageUrl, context }) =>
      call(payFetch, baseUrl, "POST", "/api/agent/process-receipt", {
        body: {
          account_id: requireAccount(),
          ...(imageBase64 ? { image_base64: imageBase64 } : {}),
          ...(imageUrl ? { image_url: imageUrl } : {}),
          ...(context ? { context } : {}),
        },
      }),

    query: async ({ query }) =>
      call(payFetch, baseUrl, "POST", "/api/agent/query", {
        body: { account_id: requireAccount(), query },
      }),

    monthlyReport: async ({ month }) =>
      call(payFetch, baseUrl, "GET", "/api/agent/monthly-report", {
        query: { account_id: requireAccount(), month },
      }),

    annualReport: async ({ year }) =>
      call(payFetch, baseUrl, "GET", "/api/agent/annual-report", {
        query: { account_id: requireAccount(), year },
      }),

    exportCsv: async ({ start, end }) =>
      call(payFetch, baseUrl, "GET", "/api/agent/export-csv", {
        query: { account_id: requireAccount(), start, end },
      }),
  };
}
