import assert from "node:assert/strict";
import test from "node:test";

import type { ServerManagedWebMcpSnapshot } from "./snapshot-contract";
import {
  isOpenAlexVerifiedCanonicalSnapshot,
  OpenAlexWebMcpVerifier,
} from "./openalex-verifier";

function snapshot(
  identifiers: ServerManagedWebMcpSnapshot["paper"]["identifiers"] = [
    { scheme: "doi", value: "10.5555/verified.1" },
  ],
): ServerManagedWebMcpSnapshot {
  return {
    paper: {
      id: `webmcp-${"a".repeat(64)}`,
      title: "Verified research systems",
      shortTitle: "Verified research systems",
      authors: ["Ada Evidence"],
      year: 2026,
      venue: "Agent Claims Quarterly",
      type: "journal article",
      abstract: "Agent text must not outrank provider evidence.",
      abstractSnippet: "Agent text must not outrank provider evidence.",
      whyRead: "",
      relevanceScore: 0,
      relevanceTags: [],
      evidenceStrength: "unassessed",
      readingStatus: "unread",
      readingProgress: 0,
      estimatedMinutes: 0,
      identifiers,
      sourceUrl: "https://repository.example.org/verified",
      access: {
        isOpenAccess: false,
        hasFullText: false,
        landingPageUrl: "https://repository.example.org/verified",
      },
      isDemoRecord: false,
    },
    provenance: {
      id: `webmcp-provenance-${"a".repeat(64)}`,
      sourceType: "web-source",
      sourceId: "https://repository.example.org/verified",
      sourceTitle: "Verified research systems",
      sourceUrl: "https://repository.example.org/verified",
      providerName: "PaperPilot WebMCP",
      retrievedAt: "2026-08-29T10:00:00.000Z",
      accessMethod: "webmcp",
      excerpt: "Agent text must not outrank provider evidence.",
    },
  };
}

function providerWork(overrides: Record<string, unknown> = {}) {
  return {
    id: "https://openalex.org/W1234567890",
    ids: {
      openalex: "https://openalex.org/W1234567890",
      doi: "https://doi.org/10.5555/verified.1",
    },
    doi: "https://doi.org/10.5555/verified.1",
    title: "Verified research systems",
    publication_year: 2026,
    publication_date: "2026-05-04",
    type: "article",
    language: "en",
    authorships: [{ author: { display_name: "Ada Evidence" } }],
    primary_location: { source: { display_name: "Trusted Systems Journal" } },
    cited_by_count: 42,
    abstract_inverted_index: { Provider: [0], metadata: [1], wins: [2] },
    is_retracted: false,
    updated_date: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

test("OpenAlex exact-work verification returns only provider canonical metadata", async () => {
  let request: Request | undefined;
  const verifier = new OpenAlexWebMcpVerifier({
    apiKey: "test-secret",
    now: () => new Date("2026-08-29T12:00:00.000Z"),
    fetchImpl: async (input, init) => {
      request = new Request(input, init);
      return Response.json(providerWork());
    },
  });
  const result = await verifier.verify(snapshot());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(request?.url ?? "", /^https:\/\/api\.openalex\.org\/works\//);
  assert.equal(request?.headers.get("authorization"), "Bearer test-secret");
  assert.equal(new URL(request?.url ?? "https://invalid").searchParams.has("api_key"), false);
  assert.equal(result.verified.paper.title, "Verified research systems");
  assert.equal(result.verified.paper.venueName, "Trusted Systems Journal");
  assert.equal(result.verified.paper.abstractText, "Provider metadata wins");
  assert.deepEqual(result.verified.paper.identifiers.map(({ type, value }) => ({ type, value })), [
    { type: "DOI", value: "10.5555/verified.1" },
    { type: "OPENALEX", value: "W1234567890" },
  ]);
  assert.match(result.verified.evidenceDigest, /^[0-9a-f]{64}$/);
});

test("the persisted OpenAlex authority decoder is closed and evidence-bound", async () => {
  const verifier = new OpenAlexWebMcpVerifier({
    apiKey: "test-secret",
    fetchImpl: async () => Response.json(providerWork()),
  });
  const result = await verifier.verify(snapshot());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(isOpenAlexVerifiedCanonicalSnapshot(result.verified), true);

  const openObject: Record<string, unknown> = {
    ...result.verified,
    agentInjected: true,
  };
  assert.equal(isOpenAlexVerifiedCanonicalSnapshot(openObject), false);
  const missingPaper = { ...result.verified } as Record<string, unknown>;
  delete missingPaper.paper;
  assert.equal(isOpenAlexVerifiedCanonicalSnapshot(missingPaper), false);
  assert.equal(isOpenAlexVerifiedCanonicalSnapshot({
    ...result.verified,
    evidenceDigest: "0".repeat(64),
  }), false);
});

test("unsupported-only claims fail closed before network access", async () => {
  let calls = 0;
  const verifier = new OpenAlexWebMcpVerifier({
    apiKey: "test-secret",
    fetchImpl: async () => {
      calls += 1;
      return Response.json(providerWork());
    },
  });
  const result = await verifier.verify(snapshot([{ scheme: "isbn", value: "9781234567890" }]));
  assert.deepEqual(result, { ok: false, reason: "unsupported_identifier" });
  assert.equal(calls, 0);
});

test("identifier and bibliographic mismatch cannot canonize an unrelated work", async () => {
  const mismatchDoi = new OpenAlexWebMcpVerifier({
    apiKey: "test-secret",
    fetchImpl: async () => Response.json(providerWork({ doi: "10.5555/other", ids: {} })),
  });
  assert.deepEqual(await mismatchDoi.verify(snapshot()), {
    ok: false,
    reason: "identifier_mismatch",
  });

  const mismatchTitle = new OpenAlexWebMcpVerifier({
    apiKey: "test-secret",
    fetchImpl: async () => Response.json(providerWork({ title: "Completely unrelated chemistry" })),
  });
  assert.deepEqual(await mismatchTitle.verify(snapshot()), {
    ok: false,
    reason: "proposal_mismatch",
  });
});

test("provider work types remain truthful and malformed authors compact safely", async () => {
  const verifier = new OpenAlexWebMcpVerifier({
    apiKey: "test-secret",
    fetchImpl: async () => Response.json(providerWork({
      type: "preprint",
      authorships: [
        { author: { display_name: "" } },
        { author: { display_name: "Ada Evidence" } },
      ],
    })),
  });
  const result = await verifier.verify(snapshot());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.verified.paper.workType, "openalex:preprint");
  assert.deepEqual(result.verified.paper.authors, [
    { position: 0, displayName: "Ada Evidence" },
  ]);
});

test("missing or malformed provider retraction state fails closed", async () => {
  for (const isRetracted of [undefined, "false", null]) {
    const verifier = new OpenAlexWebMcpVerifier({
      apiKey: "test-secret",
      fetchImpl: async () => Response.json(providerWork({ is_retracted: isRetracted })),
    });
    assert.deepEqual(await verifier.verify(snapshot()), {
      ok: false,
      reason: "provider_response_invalid",
    });
  }
});

test("title containment, oversized provider fields, and missing configuration fail closed", async () => {
  const containment = new OpenAlexWebMcpVerifier({
    apiKey: "test-secret",
    fetchImpl: async () => Response.json(providerWork({
      title: "Verified research systems plus a wholly unrelated clinical chemistry appendix",
    })),
  });
  assert.deepEqual(await containment.verify(snapshot()), {
    ok: false,
    reason: "proposal_mismatch",
  });

  const oversized = new OpenAlexWebMcpVerifier({
    apiKey: "test-secret",
    fetchImpl: async () => Response.json(providerWork({ title: "x".repeat(2_001) })),
  });
  assert.deepEqual(await oversized.verify(snapshot()), {
    ok: false,
    reason: "provider_response_invalid",
  });

  const missingKey = new OpenAlexWebMcpVerifier({ apiKey: "" });
  assert.deepEqual(await missingKey.verify(snapshot()), {
    ok: false,
    reason: "not_configured",
  });
});

test("malformed content lengths and absolute body deadlines fail closed", async () => {
  const nonCanonicalMediaType = new OpenAlexWebMcpVerifier({
    apiKey: "test-secret",
    fetchImpl: async () => new Response(JSON.stringify(providerWork()), {
      headers: { "content-type": "application/problem+json" },
    }),
  });
  assert.deepEqual(await nonCanonicalMediaType.verify(snapshot()), {
    ok: false,
    reason: "provider_response_invalid",
  });

  const malformedLength = new OpenAlexWebMcpVerifier({
    apiKey: "test-secret",
    fetchImpl: async () => new Response(JSON.stringify(providerWork()), {
      headers: { "content-type": "application/json", "content-length": "+10" },
    }),
  });
  assert.deepEqual(await malformedLength.verify(snapshot()), {
    ok: false,
    reason: "provider_response_invalid",
  });

  const deadline = new OpenAlexWebMcpVerifier({
    apiKey: "test-secret",
    timeoutMs: 5,
    fetchImpl: async () => new Response(new ReadableStream({
      start() {
        // Deliberately never enqueue or close; AbortSignal does not own this
        // injected stream, so only the verifier's absolute race can finish.
      },
    }), { headers: { "content-type": "application/json" } }),
  });
  assert.deepEqual(await deadline.verify(snapshot()), {
    ok: false,
    reason: "provider_unavailable",
  });
});

test("unused and timed-out provider bodies are cancelled without extending the deadline", async () => {
  let invalidMediaCancelled = false;
  const invalidMedia = new OpenAlexWebMcpVerifier({
    apiKey: "test-secret",
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("not-json"));
      },
      cancel() {
        invalidMediaCancelled = true;
      },
    }), { headers: { "content-type": "text/plain" } }),
  });
  assert.deepEqual(await invalidMedia.verify(snapshot()), {
    ok: false,
    reason: "provider_response_invalid",
  });
  assert.equal(invalidMediaCancelled, true);

  let redirectBodyCancelled = false;
  const invalidRedirect = new OpenAlexWebMcpVerifier({
    apiKey: "test-secret",
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        redirectBodyCancelled = true;
      },
    }), {
      status: 302,
      headers: { location: "https://attacker.example/steal" },
    }),
  });
  assert.deepEqual(await invalidRedirect.verify(snapshot()), {
    ok: false,
    reason: "provider_unavailable",
  });
  assert.equal(redirectBodyCancelled, true);

  let deadlineBodyCancelled = false;
  const deadline = new OpenAlexWebMcpVerifier({
    apiKey: "test-secret",
    timeoutMs: 5,
    fetchImpl: async () => new Response(new ReadableStream({
      cancel() {
        deadlineBodyCancelled = true;
      },
    }), { headers: { "content-type": "application/json" } }),
  });
  assert.deepEqual(await deadline.verify(snapshot()), {
    ok: false,
    reason: "provider_unavailable",
  });
  assert.equal(deadlineBodyCancelled, true);
});

test("redirects remain bounded to the exact OpenAlex work endpoint", async () => {
  const safe = new OpenAlexWebMcpVerifier({
    apiKey: "test-secret",
    fetchImpl: async (input) => new URL(String(input)).pathname.includes("W1234567890")
      ? Response.json(providerWork())
      : new Response(null, {
          status: 301,
          headers: { location: "https://api.openalex.org/works/W1234567890" },
        }),
  });
  assert.equal((await safe.verify(snapshot())).ok, true);

  const unsafe = new OpenAlexWebMcpVerifier({
    apiKey: "test-secret",
    fetchImpl: async () => new Response(null, {
      status: 302,
      headers: { location: "https://attacker.example/steal" },
    }),
  });
  assert.deepEqual(await unsafe.verify(snapshot()), {
    ok: false,
    reason: "provider_unavailable",
  });
});
