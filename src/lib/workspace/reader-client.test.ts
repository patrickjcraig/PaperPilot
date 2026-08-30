import assert from "node:assert/strict";
import test from "node:test";
import {
  HttpWorkspaceClient,
  parseWorkspacePaperReader,
} from "./http-client";
import {
  appendReaderPage,
  readerPollingDelayMs,
  readerNeedsRefresh,
} from "./reader-state";
import type { WorkspacePaperReaderDto } from "./contracts";

const timestamp = "2026-08-28T12:00:00.000Z";
const inputDigest = "a".repeat(64);
const toolchainDigest = "b".repeat(64);
const manifestDigest = "c".repeat(64);
const contentDigest = "d".repeat(64);
const continuationCursor = `r1.${"p".repeat(40)}.${"s".repeat(43)}`;

const document = {
  id: "document:one",
  workspacePaperId: "workspace-paper:one",
  paperId: "paper:one",
  assetId: "asset:one",
  inputSha256: inputDigest,
  inputSizeBytes: "1700",
  pageCount: 2,
  validationAttestationId: "validation:one",
  validationPolicyVersion: "pdf-validation-v1",
  validatedAt: timestamp,
};

const generation = {
  id: "extraction:one",
  validationAttestationId: "validation:one",
  policyVersion: "text-extraction-v1",
  toolchainDigest,
  engine: "poppler" as const,
  engineVersion: "25.06.0",
  verdict: "EXTRACTED" as const,
  pageCount: 2,
  chunkCount: 3,
  textBytes: 42,
  extractedAt: "2026-08-28T12:01:00.000Z",
  completedAt: "2026-08-28T12:01:01.000Z",
  checkedAt: "2026-08-28T12:01:02.000Z",
  manifestSha256: manifestDigest,
  manifestSchemaVersion: 1 as const,
  manifestAdmittedAt: "2026-08-28T12:01:03.000Z",
};

function chunk(sequence: number, text = `Source passage ${sequence}.`) {
  const pageNumber = sequence < 2 ? 1 : 2;
  const paragraphId = pageNumber === 1 ? `p1-p${sequence + 1}` : "p2-p1";
  return {
    id: `chunk:${sequence}`,
    sequence,
    pageNumber,
    paragraphId,
    text,
    contentHash: contentDigest,
    locator: {
      schemaVersion: 1 as const,
      kind: "pdf-text" as const,
      pageNumber,
      paragraphId,
    },
  };
}

function readyPage(
  chunks: ReturnType<typeof chunk>[],
  nextCursor: string | null,
): WorkspacePaperReaderDto {
  return {
    schemaVersion: 1,
    state: "ready",
    document,
    generation,
    chunks,
    nextCursor,
  };
}

test("linkValidatedDocument sends the exact versioned command and matching idempotency key", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const client = new HttpWorkspaceClient("workspace/one", async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    return Response.json({
      ok: true,
      outcome: "applied",
      aggregateVersion: 8,
      data: { paperId: "paper:one", documentId: "document:one" },
    }, { status: 201 });
  });
  const command = {
    clientOperationId: "link-operation-one",
    expectedVersion: 7,
    paperId: "paper:one",
  };

  const result = await client.linkValidatedDocument("document/one", command);

  assert.equal(result.ok, true);
  assert.equal(
    requestedUrl,
    "/api/workspaces/workspace%2Fone/documents/document%2Fone/link",
  );
  assert.equal(requestedInit?.method, "POST");
  assert.equal(requestedInit?.credentials, "same-origin");
  assert.equal(new Headers(requestedInit?.headers).get("Idempotency-Key"), command.clientOperationId);
  assert.deepEqual(JSON.parse(String(requestedInit?.body)), command);
  assert.deepEqual(Object.keys(JSON.parse(String(requestedInit?.body))).sort(), [
    "clientOperationId",
    "expectedVersion",
    "paperId",
  ]);
});

test("Reader accepts each closed state without synthesizing text", async () => {
  const states: WorkspacePaperReaderDto[] = [
    { schemaVersion: 1, state: "unavailable" },
    {
      schemaVersion: 1,
      state: "processing",
      document,
      extractionPolicyVersion: "text-extraction-v1",
    },
    {
      schemaVersion: 1,
      state: "no-text",
      document,
      generation: {
        ...generation,
        verdict: "NO_TEXT",
        chunkCount: 0,
        textBytes: 0,
      },
    },
    readyPage([chunk(0), chunk(1), chunk(2)], null),
  ];

  for (const state of states) {
    assert.deepEqual(parseWorkspacePaperReader(state), state);
  }
  assert.equal(readerNeedsRefresh(states[1]!), true);
  assert.equal(readerNeedsRefresh(states[0]!), false);
  assert.equal(readerNeedsRefresh(states[2]!), false);
  assert.equal(readerNeedsRefresh(states[3]!), false);
});

test("Reader sends an opaque cursor and validates continuation from the explicit expected sequence", async () => {
  let requestedUrl = "";
  const page = readyPage([chunk(2)], null);
  const client = new HttpWorkspaceClient("workspace/one", async (input) => {
    requestedUrl = String(input);
    return Response.json(page);
  });

  assert.deepEqual(
    await client.getPaperReader("paper:one", {
      limit: 50,
      cursor: continuationCursor,
      expectedSequence: 2,
    }),
    page,
  );
  assert.equal(
    requestedUrl,
    `/api/workspaces/workspace%2Fone/papers/paper%3Aone/reader?limit=50&cursor=${continuationCursor}`,
  );
});

test("Reader rejects pagination gaps, malformed opaque cursors, premature endings, and open union members", () => {
  const validFirstPage = readyPage([chunk(0), chunk(1)], continuationCursor);
  assert.deepEqual(parseWorkspacePaperReader(validFirstPage, 0), validFirstPage);

  const invalid: unknown[] = [
    { schemaVersion: 1, state: "unavailable", document: null },
    readyPage([chunk(1)], continuationCursor),
    readyPage([chunk(0), chunk(1)], null),
    readyPage([chunk(0)], "3"),
    readyPage([chunk(0)], `r1.payload=.${"s".repeat(43)}`),
    readyPage([chunk(0)], `r1.payload.${"s".repeat(42)}`),
    readyPage([chunk(0)], `r1.${"p".repeat(451)}.${"s".repeat(43)}`),
    readyPage([chunk(0), chunk(1), chunk(2)], continuationCursor),
    readyPage([chunk(0, "Source  passage.")], continuationCursor),
    readyPage([chunk(0, "Source\u00a0passage.")], continuationCursor),
    readyPage([chunk(0, "x".repeat(8 * 1_024 + 1))], continuationCursor),
    {
      ...readyPage([chunk(0)], continuationCursor),
      generation: { ...generation, toolchainDigest: "0".repeat(64) },
    },
    {
      ...readyPage([chunk(0)], continuationCursor),
      generation: { ...generation, chunkCount: 0, textBytes: 0 },
    },
  ];

  for (const value of invalid) {
    assert.equal(parseWorkspacePaperReader(value, 0), null);
  }
});

test("Reader refuses a continuation without both a bounded opaque cursor and expected sequence", async () => {
  let requests = 0;
  const client = new HttpWorkspaceClient("workspace:one", async () => {
    requests += 1;
    return Response.json(readyPage([chunk(2)], null));
  });

  await assert.rejects(
    client.getPaperReader("paper:one", { cursor: continuationCursor } as never),
    /expected sequence/i,
  );
  await assert.rejects(
    client.getPaperReader("paper:one", {
      cursor: "2",
      expectedSequence: 2,
    }),
    /opaque cursor/i,
  );
  await assert.rejects(
    client.getPaperReader("paper:one", {
      cursor: continuationCursor,
      expectedSequence: 0,
    }),
    /expected sequence/i,
  );
  assert.equal(requests, 0);
});

test("Reader page append preserves one attested generation and derives continuity from loaded chunks", () => {
  const first = readyPage([chunk(0), chunk(1)], continuationCursor);
  const last = readyPage([chunk(2)], null);
  assert.equal(first.state, "ready");
  assert.equal(last.state, "ready");
  if (first.state !== "ready" || last.state !== "ready") return;

  const merged = appendReaderPage(first, last);
  assert.deepEqual(merged.chunks.map((item) => item.sequence), [0, 1, 2]);
  assert.equal(merged.nextCursor, null);

  assert.throws(
    () => appendReaderPage(first, {
      ...last,
      generation: { ...last.generation, id: "extraction:other" },
    }),
    /source changed/i,
  );
  assert.throws(
    () => appendReaderPage(first, {
      ...last,
      document: { ...last.document, validatedAt: "2026-08-28T12:00:01.000Z" },
    }),
    /source changed/i,
  );
  assert.throws(
    () => appendReaderPage(first, {
      ...last,
      generation: { ...last.generation, engineVersion: "26.05.1" },
    }),
    /source changed/i,
  );
  assert.throws(
    () => appendReaderPage({
      ...first,
      chunks: [chunk(0), chunk(2)],
    }, last),
    /source changed/i,
  );
  assert.throws(
    () => appendReaderPage(first, {
      ...last,
      chunks: [chunk(1)],
    }),
    /source changed/i,
  );
});

test("Reader processing polls honor bounded server retry floors", () => {
  assert.equal(readerPollingDelayMs(), 5_000);
  assert.equal(readerPollingDelayMs(1), 5_000);
  assert.equal(readerPollingDelayMs(17), 17_000);
  assert.equal(readerPollingDelayMs(1_000_000), 120_000);
  assert.equal(readerPollingDelayMs(1.5), 5_000);
  assert.equal(readerPollingDelayMs(-1), 5_000);
});
