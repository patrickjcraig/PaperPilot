import assert from "node:assert/strict";
import test from "node:test";

import { CrawlerOriginRateLimitError } from "./crawler-rate-limit";

test("crawler origin rate-limit errors expose only bounded retry authority", () => {
  const retryAt = new Date("2026-08-29T12:00:10.000Z");
  const error = new CrawlerOriginRateLimitError(10, retryAt);
  assert.equal(error.code, "crawler_origin_rate_limited");
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfterSeconds, 10);
  assert.equal(error.retryAt, retryAt);
  assert.equal(error.message.includes("http"), false);
});
