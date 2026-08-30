import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseCreateDirectPdfTransferCommand,
  parseDirectPdfReadPlan,
  parseDirectPdfTransferPlan,
  parseFinalizeDirectPdfTransferCommand,
  uploadPdfDirectly,
} from "./direct-pdf-transfer";

const NOW = new Date("2026-08-30T16:00:00.000Z");
const SHA256 = "a".repeat(64);
const OBJECT_KEY = `tenants/${"1".repeat(64)}/assets/${"2".repeat(64)}/attempts/${"3".repeat(64)}/original.pdf`;
const TOKEN = "signed-provider-token-value";

function uploadPlan() {
  return {
    schemaVersion: 1,
    provider: "SUPABASE_STORAGE",
    uploadSessionId: "upload-1",
    attemptId: "attempt-1",
    method: "PUT",
    url: `https://avmcmmayvnjxrhrmgsdx.supabase.co/storage/v1/object/upload/sign/paperpilot-private-pdfs/${OBJECT_KEY}?token=${TOKEN}`,
    headers: {
      "cache-control": "max-age=0",
      "content-type": "application/pdf",
      "x-upsert": "false",
    },
    expectedSizeBytes: 17,
    expectedSha256: SHA256,
    expiresAt: "2026-08-30T18:00:00.000Z",
    finalizeUrl: "/api/workspaces/workspace-1/uploads/upload-1/finalize",
  };
}

describe("direct private PDF transfer contract", () => {
  it("accepts one exact Supabase signed-upload profile", () => {
    assert.deepEqual(parseDirectPdfTransferPlan(uploadPlan(), NOW), uploadPlan());
  });

  it("rejects redirected, widened, stale, or open DTOs", () => {
    const mutations: Array<(value: ReturnType<typeof uploadPlan>) => void> = [
      (value) => { value.url = value.url.replace("avmcmmayvnjxrhrmgsdx", "attacker"); },
      (value) => { value.url = value.url.replace("https:", "http:"); },
      (value) => { value.url += "&other=1"; },
      (value) => { value.method = "POST"; },
      (value) => { value.headers = { ...value.headers, authorization: "Bearer secret" } as typeof value.headers; },
      (value) => { value.headers["x-upsert"] = "true"; },
      (value) => { value.expectedSha256 = SHA256.toUpperCase(); },
      (value) => { value.expiresAt = "2026-08-30T18:00:31.000Z"; },
      (value) => { value.finalizeUrl = "/api/workspaces/workspace-1/uploads/upload-other/finalize"; },
      (value) => { (value as ReturnType<typeof uploadPlan> & { bucket: string }).bucket = "public"; },
    ];
    for (const mutate of mutations) {
      const value = uploadPlan();
      mutate(value);
      assert.equal(parseDirectPdfTransferPlan(value, NOW), null);
    }
  });

  it("accepts only the closed finalize identity and rejects storage authority fields", () => {
    const command = {
      schemaVersion: 1,
      clientOperationId: "finalize-1",
      attemptId: "attempt-1",
      expectedSizeBytes: 17,
      expectedSha256: SHA256,
    };
    assert.deepEqual(parseFinalizeDirectPdfTransferCommand(command), command);
    for (const extra of ["bucket", "objectKey", "objectVersion", "etag", "url"] as const) {
      assert.equal(parseFinalizeDirectPdfTransferCommand({ ...command, [extra]: "untrusted" }), null);
    }
  });

  it("accepts only the closed transfer-request identity", () => {
    const command = {
      schemaVersion: 1,
      clientOperationId: "transfer-1",
      expectedUploadId: "upload-1",
      expectedSizeBytes: 17,
      expectedSha256: SHA256,
    };
    assert.deepEqual(parseCreateDirectPdfTransferCommand(command), command);
    for (const extra of ["bucket", "objectKey", "etag", "url"] as const) {
      assert.equal(parseCreateDirectPdfTransferCommand({ ...command, [extra]: "untrusted" }), null);
    }
    assert.equal(parseCreateDirectPdfTransferCommand({
      ...command,
      expectedSha256: SHA256.toUpperCase(),
    }), null);
  });

  it("accepts one exact private read capability without browser headers", () => {
    const plan = {
      schemaVersion: 1,
      provider: "SUPABASE_STORAGE",
      documentId: "document-1",
      method: "GET",
      url: `https://avmcmmayvnjxrhrmgsdx.supabase.co/storage/v1/object/sign/paperpilot-private-pdfs/${OBJECT_KEY}?token=${TOKEN}`,
      headers: {},
      inputSizeBytes: 17,
      inputSha256: SHA256,
      objectVersion: "version-1",
      mediaType: "application/pdf",
      expiresAt: "2026-08-30T16:05:00.000Z",
    };
    assert.deepEqual(parseDirectPdfReadPlan(plan, NOW), plan);
    assert.equal(parseDirectPdfReadPlan({ ...plan, headers: { authorization: "secret" } }, NOW), null);
  });

  it("sends the untouched File directly without credentials or ambient headers", async () => {
    class FakeXhr {
      method = "";
      url = "";
      async = false;
      withCredentials = true;
      responseType: XMLHttpRequestResponseType = "";
      status = 200;
      responseURL = uploadPlan().url;
      responseText = JSON.stringify({
        Key: `paperpilot-private-pdfs/${OBJECT_KEY}`,
      });
      sentBody?: Document | XMLHttpRequestBodyInit | null;
      readonly headers = new Headers();
      readonly upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open(method: string, url: string, async: boolean) {
        this.method = method;
        this.url = url;
        this.async = async;
      }
      setRequestHeader(name: string, value: string) { this.headers.set(name, value); }
      abort() { this.onabort?.(); }
      send(body?: Document | XMLHttpRequestBodyInit | null) {
        this.sentBody = body;
        queueMicrotask(() => {
          this.upload.onprogress?.({ loaded: 17, total: 17, lengthComputable: true } as ProgressEvent);
          this.onload?.();
        });
      }
    }

    const xhr = new FakeXhr();
    const file = new File(["12345678901234567"], "paper.pdf", { type: "application/pdf" });
    const progress: Array<{ loadedBytes: number; totalBytes: number }> = [];
    await uploadPdfDirectly(
      uploadPlan(),
      file,
      { onProgress: (value) => progress.push(value) },
      () => xhr as unknown as XMLHttpRequest,
      NOW,
    );

    assert.equal(xhr.method, "PUT");
    assert.equal(xhr.url, uploadPlan().url);
    assert.equal(xhr.withCredentials, false);
    assert.equal(xhr.headers.get("authorization"), null);
    assert.equal(xhr.headers.get("cookie"), null);
    assert.equal(xhr.headers.get("content-type"), "application/pdf");
    assert.equal(xhr.headers.get("x-upsert"), "false");
    assert.equal(xhr.sentBody, file);
    assert.deepEqual(progress, [{ loadedBytes: 17, totalBytes: 17 }]);
  });

  it("rejects a 2xx response that does not confirm the exact destination", async () => {
    class FakeXhr {
      withCredentials = false;
      responseType: XMLHttpRequestResponseType = "";
      responseURL = uploadPlan().url;
      responseText = JSON.stringify({ Key: "paperpilot-private-pdfs/other.pdf" });
      status = 200;
      readonly upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open() {}
      setRequestHeader() {}
      abort() { this.onabort?.(); }
      send() { queueMicrotask(() => this.onload?.()); }
    }
    const file = new File(["12345678901234567"], "paper.pdf", { type: "application/pdf" });
    await assert.rejects(
      uploadPdfDirectly(uploadPlan(), file, {}, () => new FakeXhr() as unknown as XMLHttpRequest, NOW),
      /provider rejected/,
    );
  });
});
