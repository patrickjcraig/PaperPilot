import assert from "node:assert/strict";
import test from "node:test";

import { protectedCrawlerExtractionIds } from "./crawler-derived-text-policy";

test("derived-text policy protects anchor and direct-note extraction dependencies", () => {
  assert.deepEqual(protectedCrawlerExtractionIds({
    anchoredExtractionIds: ["anchor-generation", "shared-generation"],
    noteReferencedExtractionIds: [
      "note-generation",
      "shared-generation",
      null,
    ],
  }), ["anchor-generation", "note-generation", "shared-generation"]);
  assert.deepEqual(protectedCrawlerExtractionIds({
    anchoredExtractionIds: [],
    noteReferencedExtractionIds: [null],
  }), []);
});
