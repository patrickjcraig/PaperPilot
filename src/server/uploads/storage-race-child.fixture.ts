import "server-only";

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { HttpProblem } from "@/server/http/problem";
import { streamAuthorizedPdfToLocalQuarantine } from "./storage";

const root = process.argv[2];
const storageAuthorityGeneration = process.argv[3];
if (!root || !storageAuthorityGeneration || !process.send) {
  throw new Error("The quarantine race child requires IPC, root, and generation.");
}

const bytes = new TextEncoder().encode("%PDF-1.7\ncross-process paused writer\n%%EOF\n");
let closeBody!: () => void;

async function payloadFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (candidate: string): Promise<void> => {
    for (const entry of await readdir(candidate, { withFileTypes: true })) {
      const target = path.join(candidate, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.name.endsWith(".part") || entry.name.endsWith(".quarantine")) {
        files.push(target);
      }
    }
  };
  await visit(directory);
  return files;
}

async function waitForWrittenPartial(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const partial = (await payloadFiles(root)).find((file) => file.endsWith(".part"));
    if (partial && (await stat(partial)).size === bytes.byteLength) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The cross-process writer did not expose its partial object.");
}

const body = new ReadableStream<Uint8Array>({
  start(controller) {
    closeBody = () => controller.close();
    controller.enqueue(bytes);
  },
});

const storing = streamAuthorizedPdfToLocalQuarantine({
  body,
  configuration: {
    quarantineRoot: root,
    maxUploadBytes: 1024 * 1024,
    streamIdleTimeoutMs: 30_000,
    streamAbsoluteTimeoutMs: 60_000,
  },
  organizationId: "organization-cross-process",
  assetId: "asset-cross-process",
  attemptId: "attempt-cross-process",
  expectedSizeBytes: BigInt(bytes.byteLength),
  expectedStorageAuthorityGeneration: storageAuthorityGeneration,
});

await waitForWrittenPartial();
process.send({ kind: "partial-ready" });

await new Promise<void>((resolve) => {
  process.once("message", (message) => {
    if (
      typeof message !== "object"
      || message === null
      || !("kind" in message)
      || message.kind !== "release"
    ) throw new Error("The quarantine race child received an invalid release.");
    resolve();
  });
});
closeBody();

try {
  await storing;
  process.send({ kind: "writer-result", outcome: "committed" });
} catch (error) {
  process.send({
    kind: "writer-result",
    outcome: "rejected",
    code: error instanceof HttpProblem ? error.code : "storage_failure",
  });
}
