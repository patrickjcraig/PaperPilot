import assert from "node:assert/strict";
import test from "node:test";
import { PdfIntakeError, readBoundedPdfResponse, safeDemoFailure } from "./pdf-intake.mjs";

function response(chunks, { headers = {}, ok = true, readError, stalled = false } = {}) {
  let reads = 0, cancels = 0, releases = 0;
  return {
    ok, headers: new Headers({ "content-type": "application/pdf", ...headers }),
    body: {
      async cancel() { cancels += 1; },
      getReader() { return {
        async read() {
          reads += 1;
          if (readError) throw readError;
          if (stalled) return new Promise(() => {});
          return chunks.length ? { done: false, value: chunks.shift() } : { done: true };
        },
        async cancel() { cancels += 1; },
        releaseLock() { releases += 1; },
      }; },
    },
    get facts() { return { reads, cancels, releases }; },
  };
}

test("bounded PDF response joins exact bytes without requiring content-length", async () => {
  const res = response([new Uint8Array([37, 80]), new Uint8Array([68, 70])]);
  assert.deepEqual(await readBoundedPdfResponse(res, { maxBytes: 4 }), new Uint8Array([37, 80, 68, 70]));
  assert.deepEqual(res.facts, { reads: 3, cancels: 0, releases: 1 });
});

for (const [name, options, code] of [
  ["non-success response", { ok: false }, "demo_http_failed"],
  ["HTML masquerading as PDF", { headers: { "content-type": "text/html" } }, "demo_not_pdf"],
  ["excess declared bytes", { headers: { "content-length": "5" } }, "demo_size_limit"],
  ["malformed declared bytes", { headers: { "content-length": "no limit" } }, "demo_size_limit"],
]) {
  test(`reject ${name} before reading the body and cancel the response`, async () => {
    const res = response([new Uint8Array([1])], options);
    await assert.rejects(readBoundedPdfResponse(res, { maxBytes: 4 }), { code });
    assert.deepEqual(res.facts, { reads: 0, cancels: 1, releases: 0 });
  });
}

test("actual streamed bytes cannot exceed an absent or dishonest length", async () => {
  for (const headers of [{}, { "content-length": "1" }]) {
    const res = response([new Uint8Array(3), new Uint8Array(2), new Uint8Array(50)], { headers });
    await assert.rejects(readBoundedPdfResponse(res, { maxBytes: 4 }), { code: "demo_size_limit" });
    assert.deepEqual(res.facts, { reads: 2, cancels: 1, releases: 1 });
  }
});

test("empty response and browsers without readable streams fail safely", async () => {
  await assert.rejects(readBoundedPdfResponse(response([]), { maxBytes: 4 }), { code: "demo_empty" });
  const noStream = response([]); noStream.body = null;
  await assert.rejects(readBoundedPdfResponse(noStream, { maxBytes: 4 }), { code: "demo_stream_unavailable" });
});

test("pre-abort prevents reads and stalled reads are interrupted without trusting abort reasons", async () => {
  const first = new AbortController(); first.abort(new Error("private reason"));
  const res = response([new Uint8Array(1)]);
  await assert.rejects(readBoundedPdfResponse(res, { maxBytes: 4, signal: first.signal }), { code: "intake_cancelled" });
  assert.equal(res.facts.reads, 0);
  const second = new AbortController(); const stalled = response([], { stalled: true });
  const pending = readBoundedPdfResponse(stalled, { maxBytes: 4, signal: second.signal });
  second.abort("private URL and credentials");
  await assert.rejects(pending, { code: "intake_cancelled" });
  assert.deepEqual(stalled.facts, { reads: 1, cancels: 1, releases: 1 });
});

test("network errors and malformed chunks never reveal implementation data", async () => {
  for (const res of [response([], { readError: new Error("https://private.example/credential") }), response(["not bytes"])]) {
    await assert.rejects(readBoundedPdfResponse(res, { maxBytes: 4 }), (error) => {
      assert.ok(error instanceof PdfIntakeError);
      assert.doesNotMatch(error.message, /private|credential|not bytes/u);
      assert.equal(res.facts.cancels, 1);
      return true;
    });
  }
  const error = new PdfIntakeError("demo_integrity_mismatch"); error.message = "untrusted replacement";
  assert.match(safeDemoFailure(error).message, /does not match the recorded Attention v7/);
  assert.equal(safeDemoFailure({ code: "demo_integrity_mismatch", message: "private" }).code, "demo_fetch_failed");
});

test("empty chunks and PDF MIME parameters preserve bytes without loosening the limit", async () => {
  const res = response([new Uint8Array(), new Uint8Array([1, 2])], { headers: { "content-type": "Application/PDF; charset=binary" } });
  assert.deepEqual(await readBoundedPdfResponse(res, { maxBytes: 2 }), new Uint8Array([1, 2]));
});

test("invalid caller budgets fail before body access", async () => {
  for (const maxBytes of [0, -1, NaN, Infinity, 1.5]) {
    const res = response([]);
    await assert.rejects(readBoundedPdfResponse(res, { maxBytes }), { code: "demo_size_limit" });
    assert.equal(res.facts.reads, 0);
  }
});
