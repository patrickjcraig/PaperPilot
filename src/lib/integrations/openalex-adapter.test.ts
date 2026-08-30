import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeProviderUrlCandidates,
  OpenAlexLiteratureSearchProvider,
} from "./openalex-adapter";

test("provider URL normalization prefers HTTPS and strips credentials and controls", () => {
  assert.equal(
    normalizeProviderUrlCandidates([
      "http://legacy.example/paper",
      "https://user:secret@secure.example/pa\u0000per\u202E",
    ]),
    "https://secure.example/paper",
  );
  assert.equal(
    normalizeProviderUrlCandidates(["http://user:secret@legacy.example/file.pdf"]),
    "http://legacy.example/file.pdf",
  );
});

test("provider URL normalization rejects relative and executable schemes", () => {
  assert.equal(
    normalizeProviderUrlCandidates([
      "/relative/paper",
      "javascript:alert(1)",
      "data:text/html,unsafe",
      "file:///private/paper.pdf",
    ]),
    undefined,
  );
});

test("OpenAlex results expose only normalized outbound landing and PDF links", async () => {
  const provider = new OpenAlexLiteratureSearchProvider({
    apiKey: "server-only-test-key",
    now: () => new Date("2026-08-28T12:00:00.000Z"),
    fetchImpl: async () => Response.json({
      meta: { count: 1 },
      results: [{
        id: "https://openalex.org/W123",
        ids: {},
        doi: null,
        title: "Safe provider links",
        publication_year: 2026,
        publication_date: "2026-01-01",
        type: "article",
        authorships: [],
        primary_location: {
          is_oa: true,
          landing_page_url: "https://primary.example/paper",
          pdf_url: "https://user:secret@files.example/pa\u0000per.pdf",
          source: { display_name: "Provider Journal" },
        },
        best_oa_location: {
          is_oa: true,
          landing_page_url: "http://legacy.example/paper",
          pdf_url: "javascript:alert(1)",
        },
        open_access: {
          is_oa: true,
          oa_url: "https://user:secret@secure.example/pa\u0000per",
        },
        has_fulltext: true,
        cited_by_count: 0,
        abstract_inverted_index: null,
        topics: [],
        keywords: [],
        is_retracted: false,
        relevance_score: 1,
        updated_date: "2026-08-01T00:00:00Z",
      }],
    }),
  });

  const response = await provider.search({
    query: "safe provider links",
    requestId: "request\r\nX-Injected: yes",
  });

  assert.match(response.requestId, /^oa-[a-zA-Z0-9-]+$/);
  assert.equal(response.results[0].paper.sourceUrl, "https://secure.example/paper");
  assert.equal(response.results[0].paper.access?.landingPageUrl, "https://secure.example/paper");
  assert.equal(response.results[0].paper.access?.pdfUrl, "https://files.example/paper.pdf");
  assert.equal(response.results[0].provenance.sourceUrl, "https://openalex.org/W123");
});

