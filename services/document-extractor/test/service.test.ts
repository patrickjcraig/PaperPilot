import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { describe, it } from "node:test";

import { JsonLineLogger } from "../src/logger.js";
import { RunnerFailure } from "../src/errors.js";
import { createDocumentExtractorService } from "../src/service.js";
import type { ExternalDocumentExtractionResponse, PopplerExtraction } from "../src/types.js";
import {
  BEARER_SECRET,
  InjectedExtractionRunner,
  PDF_BYTES,
  POLICY_VERSION,
  STORAGE_VERSION,
  TOOLCHAIN_DIGEST,
  extracted,
  httpRequest,
  postExtraction,
  startTestService,
  testConfiguration,
} from "./helpers.js";

const TOP_LEVEL_KEYS = [
  "schemaVersion", "policyVersion", "storageVersion", "toolchainDigest", "verdict",
  "input", "extraction", "chunks", "completedAt", "totalDurationMs",
].sort();

async function waitUntil(action: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await action()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for extractor state.");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

describe("document extractor HTTP service", () => {
  it("streams exact PDF custody and emits the accepted closed compact v1 response", async () => {
    const runner = new InjectedExtractionRunner();
    const paths: string[] = [];
    runner.inspectImpl = async (filePath) => {
      paths.push(filePath);
      assert.deepEqual(await readFile(filePath), PDF_BYTES);
      const info = await stat(filePath);
      assert.equal(info.isFile(), true);
      if (process.platform !== "win32") assert.equal(info.mode & 0o077, 0);
      return extracted();
    };
    const started = await startTestService({ runner });
    try {
      const response = await postExtraction(started, PDF_BYTES, {
        "X-PaperPilot-Storage-Version": "s3/object-version-1",
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers["content-type"], "application/json");
      assert.ok(response.body.byteLength < 8 * 1_024 * 1_024);
      const value = response.json() as ExternalDocumentExtractionResponse;
      assert.deepEqual(Object.keys(value).sort(), TOP_LEVEL_KEYS);
      assert.deepEqual(Object.keys(value.input).sort(), ["sha256", "sizeBytes"]);
      assert.deepEqual(Object.keys(value.extraction).sort(), [
        "chunkCount", "durationMs", "engine", "engineVersion", "extractedAt",
        "pageCount", "textBytes",
      ]);
      assert.deepEqual(Object.keys(value.chunks[0] ?? {}).sort(), [
        "pageNumber", "paragraphId", "sequence", "text",
      ]);
      assert.equal(value.schemaVersion, 1);
      assert.equal(value.policyVersion, POLICY_VERSION);
      assert.equal(value.storageVersion, "s3/object-version-1");
      assert.equal(value.toolchainDigest, TOOLCHAIN_DIGEST);
      assert.equal(value.verdict, "extracted");
      assert.equal(value.input.sha256, createHash("sha256").update(PDF_BYTES).digest("hex"));
      assert.equal(value.input.sizeBytes, String(PDF_BYTES.byteLength));
      assert.equal(value.extraction.engine, "poppler");
      assert.equal(value.extraction.chunkCount, value.chunks.length);
      assert.equal(
        value.extraction.textBytes,
        value.chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.text), 0),
      );
      assert.ok(value.extraction.extractedAt <= value.completedAt);
      assert.ok(value.totalDurationMs >= value.extraction.durationMs);
      assert.equal(paths.length, 1);
      assert.deepEqual(await readdir(started.configuration.tempRoot), []);
    } finally {
      await started.close();
    }
  });

  it("emits no_text only with no chunks or text bytes", async () => {
    const runner = new InjectedExtractionRunner();
    runner.inspection = extracted({
      outcome: "no_text",
      pageCount: 3,
      chunkCount: 0,
      textBytes: 0,
      chunks: [],
    });
    const started = await startTestService({ runner });
    try {
      const response = await postExtraction(started);
      assert.equal(response.status, 200);
      const value = response.json() as ExternalDocumentExtractionResponse;
      assert.equal(value.verdict, "no_text");
      assert.equal(value.storageVersion, STORAGE_VERSION);
      assert.equal(value.extraction.pageCount, 3);
      assert.deepEqual(value.chunks, []);
    } finally {
      await started.close();
    }
  });

  it("enforces path, method, authentication, media, policy, binding, and size", async () => {
    const owned = await testConfiguration({ PAPERPILOT_EXTRACTOR_MAX_BODY_BYTES: "64" });
    const started = await startTestService({ configuration: owned.configuration });
    try {
      assert.equal((await httpRequest({ baseUrl: started.baseUrl, path: "/missing" })).status, 404);
      assert.equal((await httpRequest({
        baseUrl: started.baseUrl,
        path: `${started.configuration.route}?mode=fast`,
        method: "POST",
      })).status, 404);
      const wrongMethod = await httpRequest({
        baseUrl: started.baseUrl,
        path: started.configuration.route,
      });
      assert.equal(wrongMethod.status, 405);
      assert.equal(wrongMethod.headers.allow, "POST");
      assert.equal((await postExtraction(started, PDF_BYTES, {
        Authorization: "Bearer wrong",
      })).status, 401);
      assert.equal((await postExtraction(started, PDF_BYTES, {
        "Content-Type": "application/pdf; charset=binary",
      })).status, 415);
      assert.equal((await postExtraction(started, PDF_BYTES, {
        "Content-Encoding": "identity",
      })).status, 400);
      assert.equal((await postExtraction(started, PDF_BYTES, {
        "X-PaperPilot-Extraction-Policy": "other-policy-v1",
      })).status, 409);
      assert.equal((await postExtraction(started, PDF_BYTES, {
        "X-PaperPilot-Content-SHA256": "a".repeat(64),
      })).status, 422);
      assert.equal((await postExtraction(started, Buffer.alloc(65, 0x61))).status, 413);
      assert.equal(started.runner.inspectCalls, 0);
    } finally {
      await started.close();
      await owned.removeTempRoot();
    }
  });

  it("keeps liveness public, rejects health bodies, and authenticates bounded readiness", async () => {
    const runner = new InjectedExtractionRunner();
    let entered!: () => void;
    let release!: () => void;
    const blocked = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const startedInspection = new Promise<void>((resolvePromise) => { entered = resolvePromise; });
    runner.inspectImpl = async () => {
      entered();
      await blocked;
      return extracted();
    };
    const owned = await testConfiguration({ PAPERPILOT_EXTRACTOR_MAX_CONCURRENT: "1" });
    const started = await startTestService({ configuration: owned.configuration, runner });
    try {
      assert.equal((await httpRequest({ baseUrl: started.baseUrl, path: "/livez" })).status, 200);
      const body = await httpRequest({
        baseUrl: started.baseUrl,
        path: "/livez",
        headers: { "Content-Length": "99999999" },
      });
      assert.equal(body.status, 400);
      assert.equal(body.headers.connection, "close");
      assert.equal((await httpRequest({ baseUrl: started.baseUrl, path: "/readyz" })).status, 401);
      const ready = await httpRequest({
        baseUrl: started.baseUrl,
        path: "/readyz",
        headers: { Authorization: `Bearer ${BEARER_SECRET}` },
      });
      assert.equal(ready.status, 200);
      assert.equal(ready.headers["content-type"], "application/json");
      assert.equal(ready.body.toString("utf8"), JSON.stringify({
        schemaVersion: 1,
        status: "ready",
        policyVersion: POLICY_VERSION,
        toolchainDigest: TOOLCHAIN_DIGEST,
        engine: "poppler",
        engineVersion: "25.06.0",
      }));

      const extraction = postExtraction(started);
      await startedInspection;
      assert.equal((await httpRequest({
        baseUrl: started.baseUrl,
        path: "/readyz",
        headers: { Authorization: `Bearer ${BEARER_SECRET}` },
      })).status, 503);
      release();
      assert.equal((await extraction).status, 200);
    } finally {
      release?.();
      await started.close();
      await owned.removeTempRoot();
    }
  });

  it("treats malformed runner results as retryable service failures and bounds escaped JSON", async () => {
    const badEngine = new InjectedExtractionRunner();
    badEngine.inspection = {
      ...extracted(),
      engine: "other",
    } as unknown as PopplerExtraction;
    const first = await startTestService({ runner: badEngine });
    try {
      const response = await postExtraction(first);
      assert.equal(response.status, 503);
      assert.deepEqual(response.json(), {
        error: {
          code: "extraction_unavailable",
          message: "Document extraction is temporarily unavailable.",
        },
      });
    } finally {
      await first.close();
    }

    const unsafeText = new InjectedExtractionRunner();
    unsafeText.inspection = {
      ...extracted(),
      chunkCount: 1,
      textBytes: 5,
      chunks: [{ sequence: 0, pageNumber: 1, paragraphId: "p1-p1", text: "a\ud800b" }],
    };
    const unsafe = await startTestService({ runner: unsafeText });
    try {
      assert.equal((await postExtraction(unsafe)).status, 503);
    } finally {
      await unsafe.close();
    }

    const owned = await testConfiguration();
    const escaped = new InjectedExtractionRunner();
    const text = "\\\"".repeat(400);
    escaped.inspection = extracted({
      pageCount: 1,
      chunkCount: 1,
      textBytes: Buffer.byteLength(text),
      chunks: [{ sequence: 0, pageNumber: 1, paragraphId: "p1-p1", text }],
    });
    const constrained = { ...owned.configuration, maxResponseBytes: 1_200 };
    const second = await startTestService({ configuration: constrained, runner: escaped });
    try {
      const response = await postExtraction(second);
      assert.equal(response.status, 500);
      assert.equal((response.json() as { error: { code: string } }).error.code, "internal_error");
      assert.deepEqual(await readdir(owned.configuration.tempRoot), []);
    } finally {
      await second.close();
      await owned.removeTempRoot();
    }
  });

  it("maps deterministic runner failures to closed 422 codes and transient failures to redacted 503", async () => {
    const runner = new InjectedExtractionRunner();
    const started = await startTestService({ runner });
    try {
      const cases = [
        ["input_unsupported", 422, "extraction_input_unsupported"],
        ["output_limit", 422, "extraction_resource_limit"],
        ["protocol", 503, "extraction_unavailable"],
        ["spawn", 503, "extraction_unavailable"],
        ["tool", 503, "extraction_unavailable"],
        ["timeout", 503, "extraction_unavailable"],
      ] as const;
      for (const [kind, status, code] of cases) {
        runner.inspectImpl = async () => { throw new RunnerFailure(kind); };
        const response = await postExtraction(started);
        assert.equal(response.status, status);
        assert.equal((response.json() as { error: { code: string } }).error.code, code);
        assert.equal(response.body.toString("utf8").includes("configured extraction runner"), false);
      }
    } finally {
      await started.close();
    }
  });

  it("fails readiness for a non-canonical or open engine identity", async () => {
    const identities = [
      {
        engine: "poppler",
        engineVersion: "25.06.0",
        privateDiagnostic: "must not cross the boundary",
      },
      { engine: "poppler", engineVersion: "25.06.0\nprivate" },
    ];
    for (const identity of identities) {
      const runner = new InjectedExtractionRunner();
      runner.readyImpl = async () => identity as Awaited<
        ReturnType<InjectedExtractionRunner["ready"]>
      >;
      const started = await startTestService({ runner });
      try {
        const response = await httpRequest({
          baseUrl: started.baseUrl,
          path: "/readyz",
          headers: { Authorization: `Bearer ${BEARER_SECRET}` },
        });
        assert.equal(response.status, 503);
        assert.equal(response.body.toString("utf8").includes("privateDiagnostic"), false);
      } finally {
        await started.close();
      }
    }
  });

  it("admits one single-use extraction, rejects a concurrent second, then closes", async () => {
    const owned = await testConfiguration({
      PAPERPILOT_EXTRACTOR_SINGLE_USE: "1",
      PAPERPILOT_EXTRACTOR_MAX_CONCURRENT: "1",
    });
    const runner = new InjectedExtractionRunner();
    let entered!: () => void;
    let release!: () => void;
    let completed!: () => void;
    const inspectionEntered = new Promise<void>((resolvePromise) => { entered = resolvePromise; });
    const inspectionBlocked = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const serviceCompleted = new Promise<void>((resolvePromise) => { completed = resolvePromise; });
    runner.inspectImpl = async () => {
      entered();
      await inspectionBlocked;
      return extracted();
    };
    const started = await startTestService({
      configuration: owned.configuration,
      runner,
      onSingleUseComplete: completed,
    });
    try {
      assert.equal((await httpRequest({ baseUrl: started.baseUrl, path: "/livez" })).status, 200);
      assert.equal((await httpRequest({
        baseUrl: started.baseUrl,
        path: "/readyz",
        headers: { Authorization: `Bearer ${BEARER_SECRET}` },
      })).status, 200);

      const first = postExtraction(started);
      await inspectionEntered;
      const second = await postExtraction(started);
      assert.equal(second.status, 503);
      assert.equal(
        (second.json() as { error: { code: string } }).error.code,
        "extractor_busy",
      );
      release();
      assert.equal((await first).status, 200);
      await serviceCompleted;
      assert.equal(started.service.server.listening, false);
      assert.equal(runner.inspectCalls, 1);
    } finally {
      release?.();
      await started.close();
      await owned.removeTempRoot();
    }
  });

  it("rejects injected single-use or production configuration above concurrency one", async () => {
    const owned = await testConfiguration();
    try {
      assert.throws(() => createDocumentExtractorService({
        ...owned.configuration,
        singleUse: true,
        maxConcurrentExtractions: 2,
      }, { extractionRunner: new InjectedExtractionRunner() }));
      assert.throws(() => createDocumentExtractorService({
        ...owned.configuration,
        production: true,
        singleUse: false,
        maxConcurrentExtractions: 1,
      }, { extractionRunner: new InjectedExtractionRunner() }));
    } finally {
      await owned.removeTempRoot();
    }
  });

  it("aborts timed-out work and cleans both timed-out and client-aborted temporary files", async () => {
    const owned = await testConfiguration({ PAPERPILOT_EXTRACTOR_EXTRACTION_TIMEOUT_MS: "100" });
    const runner = new InjectedExtractionRunner();
    runner.inspectImpl = async (_filePath, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("private timeout")), { once: true });
    });
    const started = await startTestService({ configuration: owned.configuration, runner });
    try {
      const timedOut = await postExtraction(started);
      assert.equal(timedOut.status, 503);
      assert.deepEqual(await readdir(owned.configuration.tempRoot), []);

      const endpoint = new URL(started.baseUrl);
      const socket = createConnection({ host: endpoint.hostname, port: Number(endpoint.port) });
      await new Promise<void>((resolvePromise, rejectPromise) => {
        socket.once("error", rejectPromise);
        socket.once("connect", () => {
          const digest = createHash("sha256").update(Buffer.alloc(100, 0x61)).digest("hex");
          socket.write([
            `POST ${started.configuration.route} HTTP/1.1`,
            `Host: ${endpoint.host}`,
            "Accept: application/json",
            `Authorization: Bearer ${BEARER_SECRET}`,
            "Cache-Control: no-store",
            "Content-Length: 100",
            "Content-Type: application/pdf",
            `X-PaperPilot-Content-SHA256: ${digest}`,
            `X-PaperPilot-Storage-Version: ${STORAGE_VERSION}`,
            `X-PaperPilot-Extraction-Policy: ${POLICY_VERSION}`,
            "",
            "a",
          ].join("\r\n"));
          resolvePromise();
        });
      });
      await waitUntil(async () => (await readdir(owned.configuration.tempRoot)).length > 0);
      socket.destroy();
      await waitUntil(async () => (await readdir(owned.configuration.tempRoot)).length === 0);
    } finally {
      await started.close();
      await owned.removeTempRoot();
    }
  });

  it("rehashes after Poppler and redacts errors, paths, secrets, and text from telemetry", async () => {
    const runner = new InjectedExtractionRunner();
    let call = 0;
    runner.inspectImpl = async (filePath) => {
      call += 1;
      if (call > 1) {
        throw new Error(`private ${filePath} ${BEARER_SECRET} extracted text`);
      }
      const { chmod, writeFile } = await import("node:fs/promises");
      await chmod(filePath, 0o600);
      await writeFile(filePath, "mutated");
      return extracted();
    };
    const lines: string[] = [];
    const started = await startTestService({
      runner,
      logger: new JsonLineLogger((line) => lines.push(line)),
    });
    try {
      assert.equal((await postExtraction(started)).status, 503);
      assert.equal((await postExtraction(started)).status, 503);
      const logs = lines.join("\n");
      assert.equal(logs.includes(BEARER_SECRET), false);
      assert.equal(logs.includes("input.pdf"), false);
      assert.equal(logs.includes("extracted text"), false);
      assert.deepEqual(await readdir(started.configuration.tempRoot), []);
    } finally {
      await started.close();
    }
  });

  it("rolls back a failed bind and permits one clean retry", async () => {
    const occupied = await startTestService();
    const port = new URL(occupied.baseUrl).port;
    const owned = await testConfiguration({ PAPERPILOT_EXTRACTOR_PORT: port });
    const service = createDocumentExtractorService(owned.configuration, {
      extractionRunner: new InjectedExtractionRunner(),
    });
    try {
      const failed = service.listen();
      await assert.rejects(service.listen());
      await assert.rejects(failed);
      await occupied.close();
      assert.equal(String((await service.listen()).port), port);
    } finally {
      await occupied.close();
      await service.close();
      await owned.removeTempRoot();
    }
  });
});
