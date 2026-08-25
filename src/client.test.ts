import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, XpensliApiError, type FetchLike } from "./client.js";

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}

/** A fetch stub that records calls and returns a canned response. */
function stubFetch(
  response: () => Response,
): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return response();
  };
  return { fetch, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const BASE = "https://xpensli.app";

function build(opts: {
  accountId?: string | null;
  pay?: () => Response;
  plain?: () => Response;
}) {
  const pay = stubFetch(opts.pay ?? (() => json({ ok: true })));
  const plain = stubFetch(opts.plain ?? (() => json({ ok: true })));
  const client = createClient({
    baseUrl: BASE,
    accountId: opts.accountId === undefined ? "acc_1" : opts.accountId,
    plainFetch: plain.fetch,
    payFetch: pay.fetch,
  });
  return { client, pay, plain };
}

test("provision uses plainFetch (free) and maps args to snake_case body", async () => {
  const { client, plain, pay } = build({
    plain: () => json({ account_id: "acc_new", setup_url: "https://x/setup" }),
  });
  const r = await client.provision({ userEmail: "a@b.com", agentId: "bot", scopes: ["read"] });
  assert.equal(plain.calls.length, 1);
  assert.equal(pay.calls.length, 0, "provision must not pay");
  assert.equal(plain.calls[0].url, `${BASE}/api/agent/provision`);
  assert.deepEqual(JSON.parse(plain.calls[0].init!.body as string), {
    user_email: "a@b.com",
    agent_id: "bot",
    scopes: ["read"],
  });
  assert.equal((r.data as { account_id: string }).account_id, "acc_new");
});

test("query uses payFetch with account_id + query in the body", async () => {
  const { client, pay } = build({ pay: () => json({ answer: "ok" }) });
  await client.query({ query: "how much on meals?" });
  assert.equal(pay.calls.length, 1);
  assert.equal(pay.calls[0].url, `${BASE}/api/agent/query`);
  assert.deepEqual(JSON.parse(pay.calls[0].init!.body as string), {
    account_id: "acc_1",
    query: "how much on meals?",
  });
});

test("process_receipt sends image_base64 when provided", async () => {
  const { client, pay } = build({ pay: () => json({ receipt_id: "r1" }) });
  await client.processReceipt({ imageBase64: "QkFTRTY0", context: "lunch" });
  const body = JSON.parse(pay.calls[0].init!.body as string);
  assert.equal(body.account_id, "acc_1");
  assert.equal(body.image_base64, "QkFTRTY0");
  assert.equal(body.context, "lunch");
  assert.equal(body.image_url, undefined);
});

test("monthly_report is a GET with account_id; month omitted when absent, set when present", async () => {
  const a = build({ pay: () => json({ month: "2026-03" }) });
  await a.client.monthlyReport({});
  assert.equal(a.pay.calls[0].init!.method, "GET");
  assert.equal(a.pay.calls[0].url, `${BASE}/api/agent/monthly-report?account_id=acc_1`);

  const b = build({ pay: () => json({ month: "2026-04" }) });
  await b.client.monthlyReport({ month: "2026-04" });
  assert.equal(b.pay.calls[0].url, `${BASE}/api/agent/monthly-report?account_id=acc_1&month=2026-04`);
});

test("annual_report and export_csv put params in the query string", async () => {
  const a = build({ pay: () => json({ year: 2026 }) });
  await a.client.annualReport({ year: "2026" });
  assert.equal(a.pay.calls[0].url, `${BASE}/api/agent/annual-report?account_id=acc_1&year=2026`);

  const b = build({ pay: () => json({ receipt_count: 3 }) });
  await b.client.exportCsv({ start: "2026-01-01", end: "2026-12-31" });
  assert.equal(
    b.pay.calls[0].url,
    `${BASE}/api/agent/export-csv?account_id=acc_1&start=2026-01-01&end=2026-12-31`,
  );
});

test("paid calls without an account_id throw an actionable error before any fetch", async () => {
  const { client, pay } = build({ accountId: null });
  await assert.rejects(() => client.query({ query: "x" }), /XPENSLI_ACCOUNT_ID is not set/);
  assert.equal(pay.calls.length, 0, "must not attempt payment without an account");
});

test("non-2xx responses throw XpensliApiError carrying status + body", async () => {
  const { client } = build({ pay: () => json({ error: "boom" }, 500) });
  await assert.rejects(
    () => client.query({ query: "x" }),
    (err: unknown) => {
      assert.ok(err instanceof XpensliApiError);
      assert.equal(err.status, 500);
      assert.deepEqual(err.body, { error: "boom" });
      return true;
    },
  );
});

test("403 exposes setup_url via the error's setupUrl getter", async () => {
  const { client } = build({
    pay: () => json({ error: "account_not_linked", setup_url: "https://xpensli.app/setup/acc_1?token=t" }, 403),
  });
  await assert.rejects(
    () => client.query({ query: "x" }),
    (err: unknown) => {
      assert.ok(err instanceof XpensliApiError);
      assert.equal(err.setupUrl, "https://xpensli.app/setup/acc_1?token=t");
      return true;
    },
  );
});

test("settlement tx is decoded from the X-PAYMENT-RESPONSE header", async () => {
  const header = Buffer.from(JSON.stringify({ transaction: "0xdeadbeef" })).toString("base64");
  const { client } = build({
    pay: () => json({ answer: "ok" }, 200, { "x-payment-response": header }),
  });
  const r = await client.query({ query: "x" });
  assert.equal(r.settlementTx, "0xdeadbeef");
});

test("missing X-PAYMENT-RESPONSE header yields null settlement tx", async () => {
  const { client } = build({ pay: () => json({ answer: "ok" }) });
  const r = await client.query({ query: "x" });
  assert.equal(r.settlementTx, null);
});
