import assert from "node:assert/strict";
import test from "node:test";

import { HttpProblem } from "./problem";
import {
  readJsonObject,
  requestWithinBodyLimit,
  requireTrustedMutationRequest,
} from "./request";

function postRequest(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:3000/api/workspaces/workspace/projects", {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1:3000",
      "Sec-Fetch-Site": "same-origin",
      ...headers,
    },
  });
}

test("trusted mutation requests require an exact configured origin", () => {
  const priorUrl = process.env.BETTER_AUTH_URL;
  process.env.BETTER_AUTH_URL = "https://paperpilot.example";
  try {
    assert.doesNotThrow(() => requireTrustedMutationRequest(postRequest("{}", {
      Origin: "https://paperpilot.example",
    })));
    assert.throws(
      () => requireTrustedMutationRequest(postRequest("{}", {
        Origin: "https://research.paperpilot.example",
        "Sec-Fetch-Site": "same-site",
      })),
      (error: unknown) => error instanceof HttpProblem && error.status === 403,
    );
    assert.throws(
      () => requireTrustedMutationRequest(postRequest("{}", { Origin: "" })),
      (error: unknown) => error instanceof HttpProblem && error.code === "origin_required",
    );
  } finally {
    if (priorUrl === undefined) delete process.env.BETTER_AUTH_URL;
    else process.env.BETTER_AUTH_URL = priorUrl;
  }
});

test("JSON parsing enforces media type, object shape, and actual byte limit", async () => {
  assert.deepEqual(await readJsonObject(postRequest('{"name":"PaperPilot"}')), {
    name: "PaperPilot",
  });
  await assert.rejects(
    readJsonObject(postRequest("[]")),
    (error: unknown) => error instanceof HttpProblem && error.code === "validation",
  );
  await assert.rejects(
    readJsonObject(postRequest("{}", { "Content-Type": "text/plain" })),
    (error: unknown) => error instanceof HttpProblem && error.status === 415,
  );
  await assert.rejects(
    readJsonObject(postRequest('{"payload":"too large"}'), 8),
    (error: unknown) => error instanceof HttpProblem && error.status === 413,
  );
});

test("bounded requests preserve normal auth bodies and reject oversized streams", async () => {
  const original = postRequest("name=PaperPilot", {
    "Content-Type": "application/x-www-form-urlencoded",
  });
  const bounded = await requestWithinBodyLimit(original, 32);
  assert.equal(await bounded.text(), "name=PaperPilot");
  assert.equal(bounded.headers.get("content-type"), "application/x-www-form-urlencoded");

  await assert.rejects(
    requestWithinBodyLimit(postRequest("x".repeat(64)), 32),
    (error: unknown) => error instanceof HttpProblem && error.status === 413,
  );
});
