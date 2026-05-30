import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatResult, formatError, resolveImage } from "./tools.js";
import { XpensliApiError } from "./client.js";

test("formatResult renders data and appends the settlement tx when present", () => {
  const r = formatResult({ data: { answer: "ok" }, settlementTx: "0xabc" });
  const text = (r.content[0] as { text: string }).text;
  assert.match(text, /"answer": "ok"/);
  assert.match(text, /settled on Base, tx 0xabc/);
  assert.notEqual(r.isError, true);
});

test("formatResult omits the settlement line when there is no tx", () => {
  const r = formatResult({ data: { ok: true }, settlementTx: null });
  const text = (r.content[0] as { text: string }).text;
  assert.doesNotMatch(text, /settled on Base/);
});

test("formatError maps a 403 with setup_url to a Gmail-setup instruction", () => {
  const err = new XpensliApiError(403, { setup_url: "https://xpensli.app/setup/acc_1?token=t" });
  const r = formatError(err);
  assert.equal(r.isError, true);
  const text = (r.content[0] as { text: string }).text;
  assert.match(text, /finish Gmail authorization/i);
  assert.match(text, /https:\/\/xpensli\.app\/setup\/acc_1\?token=t/);
});

test("formatError surfaces status + body for other API errors", () => {
  const r = formatError(new XpensliApiError(500, { error: "boom" }));
  assert.equal(r.isError, true);
  assert.match((r.content[0] as { text: string }).text, /HTTP 500.*boom/);
});

test("formatError handles plain Errors", () => {
  const r = formatError(new Error("wallet missing"));
  assert.equal(r.isError, true);
  assert.match((r.content[0] as { text: string }).text, /wallet missing/);
});

test("resolveImage passes through a public image_url", async () => {
  const out = await resolveImage({ image_url: "https://x/r.png" });
  assert.deepEqual(out, { imageUrl: "https://x/r.png" });
});

test("resolveImage rejects when neither or both image inputs are given", async () => {
  await assert.rejects(() => resolveImage({}), /exactly one/);
  await assert.rejects(
    () => resolveImage({ image_path: "/tmp/a.png", image_url: "https://x/r.png" }),
    /exactly one/,
  );
});

test("resolveImage reads a local file and base64-encodes it", async () => {
  const path = join(tmpdir(), `xpensli-mcp-test-${process.pid}.bin`);
  await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  try {
    const out = await resolveImage({ image_path: path });
    assert.equal(out.imageBase64, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"));
    assert.equal(out.imageUrl, undefined);
  } finally {
    await rm(path, { force: true });
  }
});
