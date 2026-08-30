import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { describe, it } from "node:test";

import { JsonLineLogger } from "../src/logger.js";
import { createDocumentValidatorService } from "../src/service.js";
import type { ExternalDocumentValidationResponse } from "../src/types.js";
import {
  BEARER_SECRET,
  InjectedMalwareRunner,
  InjectedPdfRunner,
  PDF_BYTES,
  POLICY_VERSION,
  STORAGE_VERSION,
  TOOLCHAIN_DIGEST,
  cleanMalware,
  httpRequest,
  postValidation,
  startTestService,
  testConfiguration,
  validPdf,
  validationHeaders,
} from "./helpers.js";

const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "policyVersion",
  "storageVersion",
  "toolchainDigest",
  "verdict",
  "rejectionCode",
  "input",
  "malware",
  "pdf",
  "completedAt",
  "totalDurationMs",
].sort();

describe("document validator HTTP service", () => {
  it("streams one bound PDF through a private file and emits the exact compact v1 attestation", async () => {
    const malwareRunner = new InjectedMalwareRunner();
    const pdfRunner = new InjectedPdfRunner();
    const seenPaths: string[] = [];
    malwareRunner.inspectImpl = async (filePath) => {
      seenPaths.push(filePath);
      assert.deepEqual(await readFile(filePath), PDF_BYTES);
      const info = await stat(filePath);
      assert.equal(info.isFile(), true);
      if (process.platform !== "win32") assert.equal(info.mode & 0o077, 0);
      return cleanMalware();
    };
    pdfRunner.inspectImpl = async (filePath) => {
      seenPaths.push(filePath);
      assert.equal(filePath, seenPaths[0]);
      return validPdf();
    };
    const started = await startTestService({ malwareRunner, pdfRunner });
    try {
      const response = await postValidation(started);
      assert.equal(response.status, 200);
      assert.equal(response.headers["content-type"], "application/json");
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.headers["x-paperpilot-attestation-signature"], undefined);
      assert.ok(response.body.byteLength < 16 * 1_024);

      const attestation = response.json() as ExternalDocumentValidationResponse;
      assert.deepEqual(Object.keys(attestation).sort(), TOP_LEVEL_KEYS);
      assert.deepEqual(Object.keys(attestation.input).sort(), ["sha256", "sizeBytes"]);
      assert.deepEqual(Object.keys(attestation.malware).sort(), [
        "detectionCount", "durationMs", "engine", "engineVersion", "scannedAt",
        "signaturePublishedAt", "signatureVersion", "verdict",
      ]);
      assert.deepEqual(Object.keys(attestation.pdf).sort(), [
        "checkedAt", "durationMs", "engine", "engineVersion", "objectCount",
        "pageCount", "pdfVersion", "revisionCount", "structuralVerdict", "warningCount",
      ]);
      assert.equal(attestation.schemaVersion, 1);
      assert.equal(attestation.policyVersion, POLICY_VERSION);
      assert.equal(attestation.storageVersion, STORAGE_VERSION);
      assert.equal(attestation.toolchainDigest, TOOLCHAIN_DIGEST);
      assert.equal(attestation.input.sha256, createHash("sha256").update(PDF_BYTES).digest("hex"));
      assert.equal(attestation.input.sizeBytes, String(PDF_BYTES.byteLength));
      assert.equal(attestation.verdict, "accepted");
      assert.equal(attestation.rejectionCode, null);
      assert.ok(attestation.malware.signaturePublishedAt <= attestation.malware.scannedAt);
      assert.ok(attestation.malware.scannedAt <= attestation.pdf.checkedAt);
      assert.ok(attestation.pdf.checkedAt <= attestation.completedAt);
      assert.equal(malwareRunner.inspectCalls, 1);
      assert.equal(pdfRunner.inspectCalls, 1);
      assert.deepEqual(await readdir(started.configuration.tempRoot), []);
    } finally {
      await started.close();
    }
  });

  it("maps every supported malware/PDF combination to the contract's fixed verdict matrix", async () => {
    const cases = [
      { malware: cleanMalware(), pdf: validPdf(), verdict: "accepted", code: null },
      {
        malware: cleanMalware({ verdict: "infected", detectionCount: 1 }),
        pdf: validPdf(), verdict: "rejected", code: "malware_detected",
      },
      {
        malware: cleanMalware(),
        pdf: validPdf({ outcome: "policy_violation" }),
        verdict: "rejected", code: "pdf_policy_violation",
      },
      {
        malware: cleanMalware(),
        pdf: validPdf({
          outcome: "invalid", pdfVersion: "unknown", pageCount: null,
          objectCount: null, revisionCount: null, warningCount: 1,
        }),
        verdict: "rejected", code: "pdf_invalid",
      },
      {
        malware: cleanMalware(),
        pdf: validPdf({
          outcome: "resource_limit", pdfVersion: "unknown", pageCount: null,
          objectCount: null, revisionCount: null, warningCount: 1,
        }),
        verdict: "rejected", code: "pdf_resource_limit_exceeded",
      },
      {
        malware: cleanMalware({ verdict: "infected", detectionCount: 2 }),
        pdf: validPdf({
          outcome: "invalid", pdfVersion: "unknown", pageCount: null,
          objectCount: null, revisionCount: null, warningCount: 1,
        }),
        verdict: "rejected", code: "malware_and_pdf_invalid",
      },
    ] as const;

    for (const testCase of cases) {
      const malwareRunner = new InjectedMalwareRunner();
      const pdfRunner = new InjectedPdfRunner();
      malwareRunner.inspection = testCase.malware;
      pdfRunner.inspection = testCase.pdf;
      const started = await startTestService({ malwareRunner, pdfRunner });
      try {
        const response = await postValidation(started);
        assert.equal(response.status, 200);
        const attestation = response.json() as ExternalDocumentValidationResponse;
        assert.equal(attestation.verdict, testCase.verdict);
        assert.equal(attestation.rejectionCode, testCase.code);
      } finally {
        await started.close();
      }
    }
  });

  it("never converts a structurally invalid PDF with non-null counts into a policy violation", async () => {
    const owned = await testConfiguration({ PAPERPILOT_VALIDATOR_MAX_PAGE_COUNT: "1" });
    const pdfRunner = new InjectedPdfRunner();
    pdfRunner.inspection = validPdf({
      outcome: "invalid",
      pageCount: 2,
      warningCount: 1,
    });
    const started = await startTestService({
      configuration: owned.configuration,
      pdfRunner,
    });
    try {
      const response = await postValidation(started);
      assert.equal(response.status, 200);
      const attestation = response.json() as ExternalDocumentValidationResponse;
      assert.equal(attestation.pdf.structuralVerdict, "invalid");
      assert.equal(attestation.rejectionCode, "pdf_invalid");
    } finally {
      await started.close();
      await owned.removeTempRoot();
    }
  });

  it("enforces exact path, method, authentication, media, binding, and body ceilings", async () => {
    const owned = await testConfiguration({ PAPERPILOT_VALIDATOR_MAX_BODY_BYTES: "64" });
    const started = await startTestService({ configuration: owned.configuration });
    try {
      const missing = await httpRequest({ baseUrl: started.baseUrl, path: "/missing" });
      assert.equal(missing.status, 404);

      const queried = await httpRequest({
        baseUrl: started.baseUrl,
        path: `${started.configuration.route}?mode=fast`,
        method: "POST",
      });
      assert.equal(queried.status, 404);

      const wrongMethod = await httpRequest({
        baseUrl: started.baseUrl,
        path: started.configuration.route,
      });
      assert.equal(wrongMethod.status, 405);
      assert.equal(wrongMethod.headers.allow, "POST");

      const unauthorized = await httpRequest({
        baseUrl: started.baseUrl,
        path: started.configuration.route,
        method: "POST",
        headers: validationHeaders(PDF_BYTES, { Authorization: "Bearer wrong" }),
        body: PDF_BYTES,
      });
      assert.equal(unauthorized.status, 401);

      const media = await postValidation(started, PDF_BYTES, {
        "Content-Type": "application/pdf; charset=binary",
      });
      assert.equal(media.status, 415);

      const encoded = await postValidation(started, PDF_BYTES, {
        "Content-Encoding": "identity",
      });
      assert.equal(encoded.status, 400);

      const wrongPolicy = await postValidation(started, PDF_BYTES, {
        "X-PaperPilot-Validation-Policy": "another-policy-v1",
      });
      assert.equal(wrongPolicy.status, 409);

      const wrongHash = await postValidation(started, PDF_BYTES, {
        "X-PaperPilot-Content-SHA256": "a".repeat(64),
      });
      assert.equal(wrongHash.status, 422);

      const oversizedBody = Buffer.alloc(65, 0x61);
      const oversized = await postValidation(started, oversizedBody);
      assert.equal(oversized.status, 413);
      assert.equal(started.malwareRunner.inspectCalls, 0);
      assert.equal(started.pdfRunner.inspectCalls, 0);

      for (const response of [missing, queried, wrongMethod, unauthorized, media, encoded, wrongPolicy, wrongHash, oversized]) {
        assert.equal(response.headers["content-type"], "application/json");
        const value = response.json() as { error: { code: string; message: string } };
        assert.deepEqual(Object.keys(value), ["error"]);
        assert.deepEqual(Object.keys(value.error).sort(), ["code", "message"]);
      }
    } finally {
      await started.close();
      await owned.removeTempRoot();
    }
  });

  it("rejects duplicated security headers and unknown PaperPilot headers", async () => {
    const started = await startTestService();
    try {
      const digest = createHash("sha256").update(PDF_BYTES).digest("hex");
      const duplicateHeaders = [
        "Accept", "application/json",
        "Authorization", `Bearer ${BEARER_SECRET}`,
        "Authorization", `Bearer ${BEARER_SECRET}`,
        "Cache-Control", "no-store",
        "Content-Length", String(PDF_BYTES.byteLength),
        "Content-Type", "application/pdf",
        "X-PaperPilot-Content-SHA256", digest,
        "X-PaperPilot-Storage-Version", STORAGE_VERSION,
        "X-PaperPilot-Validation-Policy", POLICY_VERSION,
      ];
      const duplicate = await httpRequest({
        baseUrl: started.baseUrl,
        path: started.configuration.route,
        method: "POST",
        headers: duplicateHeaders,
        body: PDF_BYTES,
      });
      assert.equal(duplicate.status, 400);

      const unknown = await postValidation(started, PDF_BYTES, {
        "X-PaperPilot-Debug": "true",
      });
      assert.equal(unknown.status, 400);
      assert.equal(started.malwareRunner.inspectCalls, 0);
    } finally {
      await started.close();
    }
  });

  it("cuts off an idle partial body with a fixed 408 before any runner sees it", async () => {
    const owned = await testConfiguration({
      PAPERPILOT_VALIDATOR_BODY_IDLE_TIMEOUT_MS: "100",
      PAPERPILOT_VALIDATOR_BODY_ABSOLUTE_TIMEOUT_MS: "500",
    });
    const started = await startTestService({ configuration: owned.configuration });
    try {
      const endpoint = new URL(started.baseUrl);
      const digest = createHash("sha256").update(Buffer.alloc(10, 0x61)).digest("hex");
      const rawResponse = await new Promise<string>((resolvePromise, rejectPromise) => {
        const socket = createConnection({
          host: endpoint.hostname,
          port: Number(endpoint.port),
        });
        const chunks: Buffer[] = [];
        const deadline = setTimeout(() => {
          socket.destroy();
          rejectPromise(new Error("The partial-body test did not receive a response."));
        }, 2_000);
        socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        socket.once("error", rejectPromise);
        socket.once("end", () => {
          clearTimeout(deadline);
          resolvePromise(Buffer.concat(chunks).toString("utf8"));
        });
        socket.once("connect", () => {
          socket.write([
            `POST ${started.configuration.route} HTTP/1.1`,
            `Host: ${endpoint.host}`,
            "Accept: application/json",
            `Authorization: Bearer ${BEARER_SECRET}`,
            "Cache-Control: no-store",
            "Content-Length: 10",
            "Content-Type: application/pdf",
            `X-PaperPilot-Content-SHA256: ${digest}`,
            `X-PaperPilot-Storage-Version: ${STORAGE_VERSION}`,
            `X-PaperPilot-Validation-Policy: ${POLICY_VERSION}`,
            "",
            "a",
          ].join("\r\n"));
        });
      });
      assert.match(rawResponse, /^HTTP\/1\.1 408 Request Timeout\r\n/);
      assert.match(rawResponse, /"code":"body_timeout"/);
      assert.equal(rawResponse.includes(BEARER_SECRET), false);
      assert.equal(started.malwareRunner.inspectCalls, 0);
      assert.equal(started.pdfRunner.inspectCalls, 0);
    } finally {
      await started.close();
      await owned.removeTempRoot();
    }
  });

  it("keeps liveness public but authenticates readiness and fails readiness at capacity", async () => {
    const malwareRunner = new InjectedMalwareRunner();
    let releaseInspection!: () => void;
    let enteredInspection!: () => void;
    const entered = new Promise<void>((resolvePromise) => { enteredInspection = resolvePromise; });
    const blocked = new Promise<void>((resolvePromise) => { releaseInspection = resolvePromise; });
    malwareRunner.inspectImpl = async () => {
      enteredInspection();
      await blocked;
      return cleanMalware();
    };
    const owned = await testConfiguration({ PAPERPILOT_VALIDATOR_MAX_CONCURRENT: "1" });
    const started = await startTestService({
      configuration: owned.configuration,
      malwareRunner,
    });
    try {
      const live = await httpRequest({ baseUrl: started.baseUrl, path: "/livez" });
      assert.equal(live.status, 200);

      const liveWithBody = await httpRequest({
        baseUrl: started.baseUrl,
        path: "/livez",
        headers: { "Content-Length": "99999999" },
      });
      assert.equal(liveWithBody.status, 400);
      assert.equal(liveWithBody.headers.connection, "close");

      const noSecret = await httpRequest({ baseUrl: started.baseUrl, path: "/readyz" });
      assert.equal(noSecret.status, 401);

      const ready = await httpRequest({
        baseUrl: started.baseUrl,
        path: "/readyz",
        headers: { Authorization: `Bearer ${BEARER_SECRET}` },
      });
      assert.equal(ready.status, 200);

      const validation = postValidation(started);
      await entered;
      const full = await httpRequest({
        baseUrl: started.baseUrl,
        path: "/readyz",
        headers: { Authorization: `Bearer ${BEARER_SECRET}` },
      });
      assert.equal(full.status, 503);
      releaseInspection();
      assert.equal((await validation).status, 200);
    } finally {
      releaseInspection?.();
      await started.close();
      await owned.removeTempRoot();
    }
  });

  it("does not report ready when shutdown begins during an in-flight probe", async () => {
    const malwareRunner = new InjectedMalwareRunner();
    let enteredProbe!: () => void;
    let releaseProbe!: () => void;
    const entered = new Promise<void>((resolvePromise) => { enteredProbe = resolvePromise; });
    const blocked = new Promise<void>((resolvePromise) => { releaseProbe = resolvePromise; });
    malwareRunner.readyImpl = async () => {
      enteredProbe();
      await blocked;
    };
    const started = await startTestService({ malwareRunner });
    try {
      const responsePromise = httpRequest({
        baseUrl: started.baseUrl,
        path: "/readyz",
        headers: { Authorization: `Bearer ${BEARER_SECRET}` },
      });
      await entered;
      const closePromise = started.service.close();
      releaseProbe();
      const response = await responsePromise;
      assert.equal(response.status, 503);
      assert.equal(response.headers.connection, "close");
      await closePromise;
    } finally {
      releaseProbe?.();
      await started.close();
    }
  });

  it("returns fixed safe failures and structured logs never contain runner errors, paths, or secrets", async () => {
    const privateText = `C:\\private\\tenant\\input.pdf ${BEARER_SECRET}`;
    const malwareRunner = new InjectedMalwareRunner();
    malwareRunner.inspectImpl = async () => {
      throw new Error(privateText);
    };
    const lines: string[] = [];
    const logger = new JsonLineLogger((line) => lines.push(line));
    const started = await startTestService({ malwareRunner, logger });
    try {
      const response = await postValidation(started);
      assert.equal(response.status, 503);
      assert.deepEqual(response.json(), {
        error: {
          code: "validation_unavailable",
          message: "Document validation is temporarily unavailable.",
        },
      });
      const joined = lines.join("\n");
      assert.equal(joined.includes(privateText), false);
      assert.equal(joined.includes(BEARER_SECRET), false);
      assert.equal(joined.includes("input.pdf"), false);
      for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
      assert.deepEqual(await readdir(started.configuration.tempRoot), []);
    } finally {
      await started.close();
    }
  });

  it("refuses to attest if a configured runner mutates the private input", async () => {
    const malwareRunner = new InjectedMalwareRunner();
    malwareRunner.inspectImpl = async (filePath) => {
      // Windows does not enforce POSIX 0400; on POSIX a compromised same-UID
      // runner can chmod first. The service must re-bind after all tools run.
      const { chmod, writeFile } = await import("node:fs/promises");
      await chmod(filePath, 0o600);
      await writeFile(filePath, Buffer.from("changed", "utf8"));
      return cleanMalware();
    };
    const started = await startTestService({ malwareRunner });
    try {
      const response = await postValidation(started);
      assert.equal(response.status, 503);
      assert.equal((response.json() as { error: { code: string } }).error.code, "validation_unavailable");
      assert.deepEqual(await readdir(started.configuration.tempRoot), []);
    } finally {
      await started.close();
    }
  });

  it("rolls back a failed bind and supports one clean retry without concurrent starts", async () => {
    const occupied = await startTestService();
    const occupiedPort = new URL(occupied.baseUrl).port;
    const owned = await testConfiguration({ PAPERPILOT_VALIDATOR_PORT: occupiedPort });
    const service = createDocumentValidatorService(owned.configuration, {
      malwareRunner: new InjectedMalwareRunner(),
      pdfRunner: new InjectedPdfRunner(),
    });
    try {
      const failedStart = service.listen();
      await assert.rejects(service.listen());
      await assert.rejects(failedStart);

      await occupied.close();
      const rebound = await service.listen();
      assert.equal(String(rebound.port), occupiedPort);
    } finally {
      await occupied.close();
      await service.close();
      await owned.removeTempRoot();
    }
  });
});
