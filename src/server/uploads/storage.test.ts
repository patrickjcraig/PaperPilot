import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { HttpProblem } from "@/server/http/problem";
import {
  deleteLocalQuarantineAssetCustody,
  localQuarantineStorageAuthority,
  readLocalQuarantineStorageAuthority,
  removeLocalQuarantineObject,
  streamAuthorizedPdfToLocalQuarantine,
  streamRequestToLocalQuarantine,
  type LocalQuarantineStreamInput,
  type LocalQuarantineUploadInput,
} from "./storage";

const encoder = new TextEncoder();

function byteStream(
  chunks: Uint8Array[],
  options: { onCancel?: () => void } = {},
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else controller.close();
    },
    cancel() {
      options.onCancel?.();
    },
  });
}

function byteRequest(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
  options: { signal?: AbortSignal; onCancel?: () => void } = {},
): Request {
  const body = byteStream(chunks, options);
  return new Request("https://paperpilot.test/upload", {
    method: "PUT",
    headers: {
      "Content-Type": "application/pdf",
      ...headers,
    },
    body,
    signal: options.signal,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function streamInput(
  root: string,
  bytes: Uint8Array,
  overrides: Partial<LocalQuarantineStreamInput> = {},
): LocalQuarantineStreamInput {
  return {
    body: byteStream([bytes]),
    configuration: {
      quarantineRoot: root,
      maxUploadBytes: 1024 * 1024,
      streamIdleTimeoutMs: 1_000,
      streamAbsoluteTimeoutMs: 5_000,
    },
    organizationId: "organization-one",
    assetId: "asset-one",
    attemptId: "attempt-one",
    expectedSizeBytes: BigInt(bytes.byteLength),
    ...overrides,
  };
}

function input(
  root: string,
  bytes: Uint8Array,
  overrides: Partial<LocalQuarantineUploadInput> = {},
): LocalQuarantineUploadInput {
  return {
    request: byteRequest([bytes]),
    configuration: {
      quarantineRoot: root,
      maxUploadBytes: 1024 * 1024,
      streamIdleTimeoutMs: 1_000,
      streamAbsoluteTimeoutMs: 5_000,
    },
    organizationId: "organization-one",
    assetId: "asset-one",
    attemptId: "attempt-one",
    expectedSizeBytes: BigInt(bytes.byteLength),
    ...overrides,
  };
}

async function allFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "code" in error
        && (error as { code?: unknown }).code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (
        !entry.name.startsWith(".paperpilot-local-quarantine-authority-v1")
        && !/^\.[a-f0-9]{64}\.custody-(?:deleted-v1|tombstone\.)/.test(entry.name)
      ) files.push(candidate);
    }
  }
  await visit(root);
  return files.sort();
}

function problem(code: string): (error: unknown) => boolean {
  return (error) => error instanceof HttpProblem && error.code === code;
}

function childMessage(
  child: ChildProcess,
  expectedKind: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      dispose();
      reject(error);
    };
    const onExit = (code: number | null) => {
      dispose();
      reject(new Error(`The quarantine race child exited early (${String(code)}).`));
    };
    const onMessage = (message: unknown) => {
      if (
        typeof message !== "object"
        || message === null
        || !("kind" in message)
        || message.kind !== expectedKind
      ) return;
      dispose();
      resolve(message as Record<string, unknown>);
    };
    const dispose = () => {
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", onMessage);
    };
    child.on("error", onError);
    child.on("exit", onExit);
    child.on("message", onMessage);
  });
}

async function temporaryRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "paperpilot-quarantine-test-"));
}

describe("local quarantine storage", () => {
  it("streams, hashes, screens, and finalizes one PDF without returning a path", async () => {
    const root = await temporaryRoot();
    try {
      const bytes = encoder.encode("%PDF-1.7\n1 0 obj\nendobj\n%%EOF\r\n");
      const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));
      const result = await streamRequestToLocalQuarantine(input(root, bytes, {
        request: byteRequest(chunks, { "Content-Length": String(bytes.byteLength) }),
      }));

      assert.match(result.storageKey, /^local-quarantine-v2:(?:[a-f0-9]{64}:){2}[a-f0-9]{64}$/);
      assert.equal(result.storageKey.includes(root), false);
      assert.equal(result.sizeBytes, BigInt(bytes.byteLength));
      assert.equal(result.mimeType, "application/pdf");
      assert.equal(result.pdfVersion, "1.7");
      assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
      assert.equal(result.md5, createHash("md5").update(bytes).digest("hex"));
      assert.match(result.storageAuthorityGeneration, /^[a-f0-9]{64}$/);

      const files = await allFiles(root);
      assert.equal(files.length, 1);
      assert.match(path.basename(files[0]), /^[a-f0-9]{64}\.quarantine$/);
      assert.deepEqual(await readFile(files[0]), Buffer.from(bytes));
      assert.equal(files.some((file) => file.endsWith(".part")), false);

      const identity = { organizationId: "organization-one", assetId: "asset-one" };
      await removeLocalQuarantineObject({ quarantineRoot: root }, result.storageKey, identity);
      await removeLocalQuarantineObject({ quarantineRoot: root }, result.storageKey, identity);
      assert.deepEqual(await allFiles(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stores an authorized generic stream and returns both content digests", async () => {
    const root = await temporaryRoot();
    try {
      const bytes = encoder.encode("%PDF-2.0\ngeneric provider bytes\n%%EOF\r\n");
      const expectedMd5 = createHash("md5").update(bytes).digest("hex");
      const result = await streamAuthorizedPdfToLocalQuarantine(
        streamInput(root, bytes, {
          body: byteStream([
            bytes.subarray(0, 7),
            bytes.subarray(7, 19),
            bytes.subarray(19),
          ]),
          expectedMd5,
        }),
      );

      assert.equal(result.sizeBytes, BigInt(bytes.byteLength));
      assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
      assert.equal(result.md5, expectedMd5);
      assert.equal(result.pdfVersion, "2.0");
      assert.deepEqual(await Promise.all((await allFiles(root)).map((file) => readFile(file))), [
        Buffer.from(bytes),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a provider MD5 mismatch before finalization and cleans every attempt file", async () => {
    const parent = await temporaryRoot();
    const root = path.join(parent, "quarantine");
    try {
      const bytes = encoder.encode("%PDF-1.7\nprovider digest mismatch\n%%EOF\n");
      await assert.rejects(
        streamAuthorizedPdfToLocalQuarantine(streamInput(root, bytes, {
          expectedMd5: "00000000000000000000000000000000",
        })),
        problem("content_md5_mismatch"),
      );
      assert.deepEqual(await allFiles(root), []);

      const invalidRoot = path.join(parent, "invalid-expectation");
      await assert.rejects(
        streamAuthorizedPdfToLocalQuarantine(streamInput(invalidRoot, bytes, {
          expectedMd5: "NOT-CANONICAL",
        })),
        TypeError,
      );
      assert.deepEqual(await allFiles(invalidRoot), []);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects generic-stream early EOF and overflow without retaining bytes", async () => {
    const root = await temporaryRoot();
    try {
      const bytes = encoder.encode("%PDF-1.7\nbounded provider body\n%%EOF\n");
      await assert.rejects(
        streamAuthorizedPdfToLocalQuarantine(streamInput(root, bytes, {
          body: byteStream([bytes.subarray(0, bytes.byteLength - 1)]),
          attemptId: "early-eof",
        })),
        problem("content_length_mismatch"),
      );
      assert.deepEqual(await allFiles(root), []);

      let cancelled = false;
      const overflowingBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([...bytes, 0x20]));
        },
        cancel() {
          cancelled = true;
        },
      });
      await assert.rejects(
        streamAuthorizedPdfToLocalQuarantine(streamInput(root, bytes, {
          body: overflowingBody,
          attemptId: "overflow",
          configuration: {
            quarantineRoot: root,
            maxUploadBytes: bytes.byteLength,
            streamIdleTimeoutMs: 1_000,
            streamAbsoluteTimeoutMs: 5_000,
          },
        })),
        problem("upload_too_large"),
      );
      assert.equal(cancelled, true);
      assert.deepEqual(await allFiles(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honors generic-stream cancellation and removes a partial object", async () => {
    const root = await temporaryRoot();
    try {
      const bytes = encoder.encode("%PDF-1.7\nprovider stream still open\n%%EOF\n");
      const abortController = new AbortController();
      let cancelCalled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 16));
        },
        cancel() {
          cancelCalled = true;
          return new Promise<void>(() => undefined);
        },
      });
      const storing = streamAuthorizedPdfToLocalQuarantine(streamInput(root, bytes, {
        body,
        signal: abortController.signal,
      }));

      let observedPartial = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const partial = (await allFiles(root)).find((file) => file.endsWith(".part"));
        if (partial && (await stat(partial)).size > 0) {
          observedPartial = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(observedPartial, true);
      abortController.abort();
      await assert.rejects(storing, problem("upload_aborted"));
      assert.equal(cancelCalled, true);
      assert.deepEqual(await allFiles(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds authorized streams by both idle and absolute deadlines", async () => {
    const root = await temporaryRoot();
    try {
      const bytes = encoder.encode("%PDF-1.7\nslow provider body\n%%EOF\n");
      let idleCancelled = false;
      const stalled = new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => undefined);
        },
        cancel() {
          idleCancelled = true;
          return new Promise<void>(() => undefined);
        },
      });
      await assert.rejects(
        streamAuthorizedPdfToLocalQuarantine(streamInput(root, bytes, {
          body: stalled,
          attemptId: "idle-deadline",
          configuration: {
            quarantineRoot: root,
            maxUploadBytes: 1024,
            streamIdleTimeoutMs: 20,
            streamAbsoluteTimeoutMs: 100,
          },
        })),
        problem("upload_timed_out"),
      );
      assert.equal(idleCancelled, true);
      assert.deepEqual(await allFiles(root), []);

      let index = 0;
      let absoluteCancelled = false;
      const slowlyProgressing = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 8));
          if (absoluteCancelled) return;
          if (index < bytes.byteLength) {
            controller.enqueue(bytes.subarray(index, index + 1));
            index += 1;
          } else {
            controller.close();
          }
        },
        cancel() {
          absoluteCancelled = true;
        },
      });
      await assert.rejects(
        streamAuthorizedPdfToLocalQuarantine(streamInput(root, bytes, {
          body: slowlyProgressing,
          attemptId: "absolute-deadline",
          configuration: {
            quarantineRoot: root,
            maxUploadBytes: 1024,
            streamIdleTimeoutMs: 30,
            streamAbsoluteTimeoutMs: 40,
          },
        })),
        problem("upload_timed_out"),
      );
      assert.equal(absoluteCancelled, true);
      assert.deepEqual(await allFiles(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does all MIME, framing, and declared-size preflight before filesystem writes", async () => {
    const parent = await temporaryRoot();
    const root = path.join(parent, "not-created");
    const bytes = encoder.encode("%PDF-1.7\n%%EOF");
    try {
      await assert.rejects(
        streamRequestToLocalQuarantine(input(root, bytes, {
          request: byteRequest([bytes], { "Content-Type": "application/pdf; charset=binary" }),
        })),
        problem("unsupported_media_type"),
      );
      await assert.rejects(
        streamRequestToLocalQuarantine(input(root, bytes, {
          request: byteRequest([bytes], { "Content-Length": `${bytes.byteLength + 1}` }),
        })),
        problem("content_length_mismatch"),
      );
      await assert.rejects(
        streamRequestToLocalQuarantine(input(root, bytes, {
          request: byteRequest([bytes], { "Content-Encoding": "gzip" }),
        })),
        problem("unsupported_content_encoding"),
      );
      await assert.rejects(
        streamRequestToLocalQuarantine(input(root, bytes, {
          request: byteRequest([bytes], {
            "Content-Length": String(bytes.byteLength),
            "Transfer-Encoding": "chunked",
          }),
        })),
        problem("invalid_content_length"),
      );
      assert.deepEqual(await allFiles(root), []);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("enforces actual expected and configured byte limits and removes attempt files", async () => {
    const root = await temporaryRoot();
    try {
      const expected = encoder.encode("%PDF-1.7\n%%EOF");
      const extra = new Uint8Array([...expected, 0x20]);
      let cancelled = false;
      const openBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(extra);
        },
        cancel() {
          cancelled = true;
        },
      });
      const openRequest = new Request("https://paperpilot.test/upload", {
        method: "PUT",
        headers: { "Content-Type": "application/pdf" },
        body: openBody,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      await assert.rejects(
        streamRequestToLocalQuarantine(input(root, expected, {
          request: openRequest,
        })),
        problem("content_length_mismatch"),
      );
      assert.equal(cancelled, true);
      assert.deepEqual(await allFiles(root), []);

      await assert.rejects(
        streamRequestToLocalQuarantine(input(root, expected, {
          request: byteRequest([expected.subarray(0, expected.byteLength - 1)]),
        })),
        problem("content_length_mismatch"),
      );
      assert.deepEqual(await allFiles(root), []);

      await assert.rejects(
        streamRequestToLocalQuarantine(input(root, expected, {
          request: byteRequest([extra]),
          configuration: {
            quarantineRoot: root,
            maxUploadBytes: expected.byteLength,
            streamIdleTimeoutMs: 1_000,
            streamAbsoluteTimeoutMs: 5_000,
          },
          expectedSizeBytes: BigInt(expected.byteLength),
        })),
        problem("upload_too_large"),
      );
      assert.deepEqual(await allFiles(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid envelopes with fixed path-free errors and cleans partial bytes", async () => {
    const root = await temporaryRoot();
    try {
      const invalid = encoder.encode("<html>not a PDF</html>");
      await assert.rejects(
        streamRequestToLocalQuarantine(input(root, invalid)),
        (error: unknown) => {
          assert.ok(error instanceof HttpProblem);
          assert.equal(error.code, "invalid_pdf_envelope");
          assert.equal(error.message.includes(root), false);
          return true;
        },
      );
      assert.deepEqual(await allFiles(root), []);

      const appended = encoder.encode("%PDF-1.7\n%%EOF\nPK\u0003\u0004");
      await assert.rejects(
        streamRequestToLocalQuarantine(input(root, appended, {
          assetId: "asset-two",
          attemptId: "attempt-two",
        })),
        problem("pdf_trailing_data"),
      );
      assert.deepEqual(await allFiles(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses generated contained paths even when identifiers contain path syntax", async () => {
    const root = await temporaryRoot();
    try {
      const bytes = encoder.encode("%PDF-2.0\n%%EOF\n");
      await streamRequestToLocalQuarantine(input(root, bytes, {
        organizationId: "../../foreign-organization",
        assetId: "C:\\outside\\asset",
        attemptId: "..\\attempt/../../escape",
      }));
      const files = await allFiles(root);
      assert.equal(files.length, 1);
      assert.match(path.basename(files[0]), /^[a-f0-9]{64}\.quarantine$/);
      assert.equal(path.relative(root, files[0]).startsWith(".."), false);
      assert.equal(files[0].includes("foreign-organization"), false);
      assert.equal(files[0].includes("outside"), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fences retries with immutable attempt objects and never overwrites one attempt", async () => {
    const root = await temporaryRoot();
    try {
      const first = encoder.encode("%PDF-1.7\nalpha\n%%EOF");
      const second = encoder.encode("%PDF-1.7\nbravo\n%%EOF");
      assert.equal(first.byteLength, second.byteLength);

      const outcomes = await Promise.allSettled([
        streamRequestToLocalQuarantine(input(root, first, {
          attemptId: "parallel-attempt",
        })),
        streamRequestToLocalQuarantine(input(root, second, {
          attemptId: "parallel-attempt",
        })),
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      const rejected = outcomes.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      assert.ok(rejected);
      assert.ok(rejected.reason instanceof HttpProblem);
      assert.equal(rejected.reason.code, "upload_already_stored");

      const files = await allFiles(root);
      assert.equal(files.length, 1);
      assert.equal(files.some((file) => file.endsWith(".part")), false);
      const stored = await readFile(files[0]);
      assert.ok(stored.equals(Buffer.from(first)) || stored.equals(Buffer.from(second)));

      const retry = await streamRequestToLocalQuarantine(input(root, first, {
        attemptId: "later-fenced-attempt",
      }));
      assert.notEqual(
        retry.storageKey,
        (outcomes.find((outcome) => outcome.status === "fulfilled") as PromiseFulfilledResult<{
          storageKey: string;
        }>).value.storageKey,
      );
      const retriedFiles = await allFiles(root);
      assert.equal(retriedFiles.length, 2);
      const retainedContents = await Promise.all(
        retriedFiles.map((file) => readFile(file)),
      );
      assert.ok(retainedContents.some((content) => content.equals(stored)));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("compensation deletion validates opaque keys and removes no sibling files", async () => {
    const root = await temporaryRoot();
    try {
      const bytes = encoder.encode("%PDF-1.7\n%%EOF\n");
      const result = await streamRequestToLocalQuarantine(input(root, bytes));
      const [storedFile] = await allFiles(root);
      const sibling = path.join(path.dirname(storedFile), "keep-for-reconciler.test");
      await writeFile(sibling, "keep", { encoding: "utf8", flag: "wx" });

      await assert.rejects(
        removeLocalQuarantineObject(
          { quarantineRoot: root },
          "../../outside",
          { organizationId: "organization-one", assetId: "asset-one" },
        ),
        problem("invalid_storage_key"),
      );
      await assert.rejects(
        removeLocalQuarantineObject(
          { quarantineRoot: root },
          result.storageKey,
          { organizationId: "organization-two", assetId: "asset-one" },
        ),
        problem("storage_key_mismatch"),
      );
      await removeLocalQuarantineObject(
        { quarantineRoot: root },
        result.storageKey,
        { organizationId: "organization-one", assetId: "asset-one" },
      );
      assert.deepEqual(await readFile(sibling, "utf8"), "keep");
      assert.deepEqual(await allFiles(root), [sibling]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("handles an already-aborted request without retaining any file", async () => {
    const root = await temporaryRoot();
    try {
      const bytes = encoder.encode("%PDF-1.7\n%%EOF");
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        streamRequestToLocalQuarantine(input(root, bytes, {
          request: byteRequest([bytes], {}, { signal: controller.signal }),
        })),
        problem("upload_aborted"),
      );
      assert.deepEqual(await allFiles(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let a never-settling cancel algorithm delay partial-file cleanup", async () => {
    const root = await temporaryRoot();
    try {
      const expected = encoder.encode("%PDF-1.7\n%%EOF");
      const oversized = new Uint8Array([...expected, 0x20]);
      let cancelCalled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(oversized);
        },
        cancel() {
          cancelCalled = true;
          return new Promise<void>(() => undefined);
        },
      });
      const request = new Request("https://paperpilot.test/upload", {
        method: "PUT",
        headers: { "Content-Type": "application/pdf" },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" });

      await assert.rejects(
        streamRequestToLocalQuarantine(input(root, expected, { request })),
        problem("content_length_mismatch"),
      );
      assert.equal(cancelCalled, true);
      assert.deepEqual(await allFiles(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds a stalled request body by the internal idle deadline", async () => {
    const root = await temporaryRoot();
    try {
      const bytes = encoder.encode("%PDF-1.7\n%%EOF");
      let cancelCalled = false;
      const body = new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => undefined);
        },
        cancel() {
          cancelCalled = true;
          return new Promise<void>(() => undefined);
        },
      });
      const request = new Request("https://paperpilot.test/upload", {
        method: "PUT",
        headers: { "Content-Type": "application/pdf" },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      const started = performance.now();
      await assert.rejects(
        streamRequestToLocalQuarantine(input(root, bytes, {
          request,
          configuration: {
            quarantineRoot: root,
            maxUploadBytes: 1024,
            streamIdleTimeoutMs: 20,
            streamAbsoluteTimeoutMs: 100,
          },
        })),
        problem("upload_timed_out"),
      );
      assert.ok(performance.now() - started < 1_000);
      assert.equal(cancelCalled, true);
      assert.deepEqual(await allFiles(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("closes and removes a partially written attempt after a mid-stream abort", async () => {
    const root = await temporaryRoot();
    try {
      const bytes = encoder.encode("%PDF-1.7\npartial body that has not reached EOF");
      const firstChunk = bytes.subarray(0, 16);
      const controller = new AbortController();
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(firstChunk);
        },
      });
      const request = new Request("https://paperpilot.test/upload", {
        method: "PUT",
        headers: { "Content-Type": "application/pdf" },
        body,
        signal: controller.signal,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      const storing = streamRequestToLocalQuarantine(input(root, bytes, { request }));

      let observedPartial = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const files = await allFiles(root);
        if (files.some((file) => file.endsWith(".part"))) {
          const partial = files.find((file) => file.endsWith(".part"))!;
          if ((await stat(partial)).size > 0) {
            observedPartial = true;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(observedPartial, true);
      controller.abort();
      await assert.rejects(storing, problem("upload_aborted"));
      assert.deepEqual(await allFiles(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("atomically tombstones and retires a writer paused before finalization", async () => {
    const root = await temporaryRoot();
    try {
      const bytes = encoder.encode("%PDF-1.7\npaused finalization race\n%%EOF\n");
      const authority = await localQuarantineStorageAuthority({ quarantineRoot: root });
      let releaseEnd!: () => void;
      const endBarrier = new Promise<void>((resolve) => {
        releaseEnd = resolve;
      });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
        },
        async pull(controller) {
          await endBarrier;
          controller.close();
        },
      });
      const storing = streamAuthorizedPdfToLocalQuarantine(streamInput(root, bytes, {
        body,
        attemptId: "paused-custody-writer",
        expectedStorageAuthorityGeneration: authority.generation,
      }));

      let observedPartial = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const partial = (await allFiles(root)).find((file) => file.endsWith(".part"));
        if (partial && (await stat(partial)).size === bytes.byteLength) {
          observedPartial = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(observedPartial, true);

      const identity = {
        organizationId: "organization-one",
        assetId: "asset-one",
      };
      const firstDeletion = await deleteLocalQuarantineAssetCustody(
        { quarantineRoot: root },
        identity,
        authority.generation,
      ).then(
        (proof) => ({ outcome: "proved" as const, proof }),
        () => ({ outcome: "retry" as const }),
      );

      releaseEnd();
      await assert.rejects(storing, problem("quarantine_custody_deleted"));
      const finalProof = await deleteLocalQuarantineAssetCustody(
        { quarantineRoot: root },
        identity,
        authority.generation,
      );
      assert.equal(finalProof.storageAuthorityGeneration, authority.generation);
      assert.match(finalProof.tombstoneDigest, /^[a-f0-9]{64}$/);
      if (firstDeletion.outcome === "proved") {
        assert.deepEqual(finalProof, firstDeletion.proof);
      }
      assert.deepEqual(await allFiles(root), []);

      await assert.rejects(
        streamAuthorizedPdfToLocalQuarantine(streamInput(root, bytes, {
          attemptId: "post-tombstone-writer",
          expectedStorageAuthorityGeneration: authority.generation,
        })),
        problem("quarantine_custody_deleted"),
      );
      assert.deepEqual(await allFiles(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let another or copied root generation certify custody absence", async () => {
    const rootA = await temporaryRoot();
    const rootB = await temporaryRoot();
    try {
      const bytes = encoder.encode("%PDF-1.7\nroot authority binding\n%%EOF\n");
      const authorityA = await localQuarantineStorageAuthority({ quarantineRoot: rootA });
      const stored = await streamAuthorizedPdfToLocalQuarantine(streamInput(rootA, bytes, {
        expectedStorageAuthorityGeneration: authorityA.generation,
      }));
      assert.equal(stored.storageAuthorityGeneration, authorityA.generation);

      await assert.rejects(
        deleteLocalQuarantineAssetCustody(
          { quarantineRoot: rootB },
          { organizationId: "organization-one", assetId: "asset-one" },
          authorityA.generation,
        ),
        problem("storage_authority_mismatch"),
      );
      assert.deepEqual(await readdir(rootB), []);
      assert.equal((await allFiles(rootA)).length, 1);

      const authorityMarker = (await readdir(rootA)).find((name) =>
        name === ".paperpilot-local-quarantine-authority-v1"
      );
      assert.ok(authorityMarker);
      await copyFile(path.join(rootA, authorityMarker), path.join(rootB, authorityMarker));
      await assert.rejects(
        readLocalQuarantineStorageAuthority({ quarantineRoot: rootB }),
        problem("storage_unavailable"),
      );
      await assert.rejects(
        deleteLocalQuarantineAssetCustody(
          { quarantineRoot: rootB },
          { organizationId: "organization-one", assetId: "asset-one" },
          authorityA.generation,
        ),
        problem("storage_unavailable"),
      );
      assert.equal((await allFiles(rootA)).length, 1);

      await deleteLocalQuarantineAssetCustody(
        { quarantineRoot: rootA },
        { organizationId: "organization-one", assetId: "asset-one" },
        authorityA.generation,
      );
      assert.deepEqual(await allFiles(rootA), []);
    } finally {
      await rm(rootA, { recursive: true, force: true });
      await rm(rootB, { recursive: true, force: true });
    }
  });

  it("fences a real second-process writer paused with an open partial", async () => {
    const root = await temporaryRoot();
    let child: ChildProcess | null = null;
    try {
      const authority = await localQuarantineStorageAuthority({ quarantineRoot: root });
      const childFixture = fileURLToPath(
        new URL("./storage-race-child.fixture.ts", import.meta.url),
      );
      child = fork(
        childFixture,
        [root, authority.generation],
        {
          execArgv: ["--conditions=react-server", "--import=tsx"],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      await childMessage(child, "partial-ready");

      const identity = {
        organizationId: "organization-cross-process",
        assetId: "asset-cross-process",
      };
      await deleteLocalQuarantineAssetCustody(
        { quarantineRoot: root },
        identity,
        authority.generation,
      ).catch(() => undefined);

      const writerResult = childMessage(child, "writer-result");
      const childExit = once(child, "exit");
      child.send({ kind: "release" });
      const result = await writerResult;
      assert.equal(result.outcome, "rejected");
      assert.ok([
        "quarantine_custody_deleted",
        "storage_unavailable",
        "upload_aborted",
        "storage_failure",
      ].includes(String(result.code)));
      await childExit;
      child = null;

      const proof = await deleteLocalQuarantineAssetCustody(
        { quarantineRoot: root },
        identity,
        authority.generation,
      );
      assert.equal(proof.storageAuthorityGeneration, authority.generation);
      assert.deepEqual(await allFiles(root), []);
    } finally {
      child?.kill();
      await rm(root, { recursive: true, force: true });
    }
  });
});
