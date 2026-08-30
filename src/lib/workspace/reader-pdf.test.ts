import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { ReaderDocumentMetadata } from "./contracts";
import {
  fetchVerifiedReaderPdf,
  ReaderPdfClientError,
  readerPdfUrl,
  sha256Hex,
} from "./reader-pdf";

function documentFor(bytes: Uint8Array): ReaderDocumentMetadata {
  return {
    id: "document:one",
    workspacePaperId: "workspace-paper:one",
    paperId: "paper/one",
    assetId: "asset:one",
    inputSha256: createHash("sha256").update(bytes).digest("hex"),
    inputSizeBytes: String(bytes.byteLength),
    pageCount: 1,
    validationAttestationId: "validation:one",
    validationPolicyVersion: "paperpilot-document-validation-v1",
    validatedAt: "2026-08-29T12:00:00.000Z",
  };
}

function admittedResponse(bytes: Uint8Array, document: ReaderDocumentMetadata): Response {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, {
    headers: {
      "Content-Type": "application/pdf",
      ETag: `"${document.inputSha256}"`,
      "X-PaperPilot-Document-Id": document.id,
      "X-PaperPilot-Document-SHA256": document.inputSha256,
    },
  });
}

test("Reader PDF URL binds the workspace, paper, document, and digest", () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
  const document = documentFor(bytes);
  const url = readerPdfUrl({
    workspaceId: "workspace/one",
    paperId: document.paperId,
    document,
  });

  assert.equal(
    url,
    `/api/workspaces/workspace%2Fone/papers/paper%2Fone/reader/pdf?documentId=document%3Aone&inputSha256=${document.inputSha256}`,
  );
});

test("Reader PDF fetch sends the admitted precondition and verifies exact bytes", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nsmall admitted PDF\n%%EOF\n");
  const document = documentFor(bytes);
  const received = await fetchVerifiedReaderPdf(
    { workspaceId: "workspace:one", paperId: document.paperId, document },
    async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("if-match"), `"${document.inputSha256}"`);
      assert.equal(init?.credentials, "same-origin");
      assert.equal(init?.cache, "no-store");
      return admittedResponse(bytes, document);
    },
  );

  assert.deepEqual(received, bytes);
  assert.equal(await sha256Hex(bytes), document.inputSha256);
});

test("Reader PDF fetch fails closed on response identity and byte mismatches", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
  const document = documentFor(bytes);
  const changed = new TextEncoder().encode("%PDF-1.7\nchanged\n%%EOF\n");

  await assert.rejects(
    fetchVerifiedReaderPdf(
      { workspaceId: "workspace:one", paperId: document.paperId, document },
      async () => new Response(bytes, { headers: { "Content-Type": "application/pdf" } }),
    ),
    (error: unknown) => error instanceof ReaderPdfClientError && error.kind === "integrity",
  );
  await assert.rejects(
    fetchVerifiedReaderPdf(
      { workspaceId: "workspace:one", paperId: document.paperId, document },
      async () => admittedResponse(changed, document),
    ),
    (error: unknown) => error instanceof ReaderPdfClientError && error.kind === "integrity",
  );
});

test("Reader PDF fetch translates generation changes without exposing a server body", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
  const document = documentFor(bytes);
  await assert.rejects(
    fetchVerifiedReaderPdf(
      { workspaceId: "workspace:one", paperId: document.paperId, document },
      async () => Response.json({ error: { message: "secret storage path" } }, { status: 412 }),
    ),
    (error: unknown) => error instanceof ReaderPdfClientError
      && error.kind === "changed"
      && !error.message.includes("storage"),
  );
});
