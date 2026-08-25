/**
 * Thin typed client over the xpensli agent HTTP API.
 *
 * Payment is injected, not built here: `payFetch` is an x402-wrapped fetch
 * that settles a USDC micropayment per request, while `plainFetch` is a normal
 * fetch used for the free `provision` endpoint. Injecting both keeps this
 * module pure and unit-testable with mocked payments.
 *
 * TENANCY. `accountId` is OPTIONAL. Omit it and the paying wallet resolves to
 * its own tenant server-side — no provisioning, no setup link, no human. Supply
 * one only for the LINKED flow, where the agent acts on behalf of an existing
 * xpensli user and receipts should land in that person's account.
 *
 * This client previously REQUIRED an account id and threw without one. That was
 * written before wallet tenancy existed and made the ordinary path unreachable.
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

  /**
   * The stable machine-readable code. Agents branch on this, never on prose.
   *
   * Ordinary errors carry it at the top level as `error`. A 402 carries it at
   * `xpensli.code` instead — the top-level `error` on a 402 belongs to the x402
   * protocol and is a closed enum we do not own.
   */
  get code(): string | null {
    const b = this.body as { error?: unknown; xpensli?: { code?: unknown } } | null;
    if (!b) return null;
    if (b.xpensli && typeof b.xpensli.code === "string") return b.xpensli.code;
    return typeof b.error === "string" ? b.error : null;
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

/**
 * POST a JSON body to an agent endpoint.
 *
 * Every endpoint is POST as of the /v1 move — the three reports used to be GET
 * with query strings. An `Idempotency-Key` on a GET is a category error, and a
 * uniform method keeps the request builder to one shape.
 */
async function call<T>(
  fetcher: FetchLike,
  baseUrl: string,
  path: string,
  body: unknown = {},
): Promise<CallResult<T>> {
  const url = new URL(baseUrl + path);
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };

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
  /** Compute endpoint: extract + categorize, stored nowhere, no tenant. */
  categorize(args: {
    imageBase64?: string;
    imageUrl?: string;
    context?: string;
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

  /**
   * The tenant hint, or nothing at all.
   *
   * Sending `account_id: null` would be WRONG, not merely redundant: the server
   * treats a present-but-null value differently from an absent key on some
   * paths, and an absent key is what selects the wallet tenant. So the property
   * is omitted entirely unless an id was configured.
   */
  const tenant = (): Record<string, string> =>
    accountId ? { account_id: accountId } : {};

  return {
    provision: async ({ userEmail, agentId, scopes }) =>
      call(plainFetch, baseUrl, "/api/agent/v1/provision", {
        user_email: userEmail,
        agent_id: agentId,
        scopes,
      }),

    categorize: async ({ imageBase64, imageUrl, context }) =>
      // Compute class: no tenant, nothing stored. Deliberately does NOT send a
      // tenant hint even when one is configured — there is nothing to store it
      // against, and sending one would imply otherwise.
      call(payFetch, baseUrl, "/api/agent/v1/categorize", {
        ...(imageBase64 ? { image_base64: imageBase64 } : {}),
        ...(imageUrl ? { image_url: imageUrl } : {}),
        ...(context ? { context } : {}),
      }),

    processReceipt: async ({ imageBase64, imageUrl, context }) =>
      call(payFetch, baseUrl, "/api/agent/v1/process-receipt", {
        ...tenant(),
        ...(imageBase64 ? { image_base64: imageBase64 } : {}),
        ...(imageUrl ? { image_url: imageUrl } : {}),
        ...(context ? { context } : {}),
      }),

    query: async ({ query }) =>
      call(payFetch, baseUrl, "/api/agent/v1/query", { ...tenant(), query }),

    monthlyReport: async ({ month }) =>
      call(payFetch, baseUrl, "/api/agent/v1/monthly-report", {
        ...tenant(),
        ...(month ? { month } : {}),
      }),

    annualReport: async ({ year }) =>
      call(payFetch, baseUrl, "/api/agent/v1/annual-report", {
        ...tenant(),
        ...(year ? { year } : {}),
      }),

    exportCsv: async ({ start, end }) =>
      call(payFetch, baseUrl, "/api/agent/v1/export-csv", { ...tenant(), start, end }),
  };
}
