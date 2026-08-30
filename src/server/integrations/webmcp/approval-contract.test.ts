import assert from "node:assert/strict";
import test from "node:test";

import { HttpProblem } from "@/server/http/problem";
import {
  parseWebMcpApprovalCommand,
  parseWebMcpApprovalPreparationCommand,
} from "./approval-contract";

const digest = "a".repeat(64);
const evidenceDigest = "b".repeat(64);
const challengeId = "A".repeat(43);

function intent() {
  return {
    expectedVersion: 8,
    inboxEntryId: "inbox-one",
    proposalDigest: digest,
    destinationProjectId: "project-one",
    duplicateDecision: { kind: "create_new" },
  };
}

function finalCommand() {
  return {
    schemaVersion: 2,
    clientOperationId: "approve-webmcp-one",
    ...intent(),
    challengeId,
    evidenceDigest,
  };
}

test("preparation decodes one exact digest-bound review intent", () => {
  const command = { schemaVersion: 1, ...intent() };
  assert.deepEqual(
    parseWebMcpApprovalPreparationCommand(command, "inbox-one"),
    command,
  );
});

test("final consent requires the exact challenge capability and evidence digest", () => {
  assert.deepEqual(
    parseWebMcpApprovalCommand(finalCommand(), "inbox-one"),
    finalCommand(),
  );
  const existing = {
    ...finalCommand(),
    duplicateDecision: { kind: "use_existing", canonicalPaperId: "paper-one" },
  };
  assert.deepEqual(parseWebMcpApprovalCommand(existing, "inbox-one"), existing);
});

test("historical v1 consent remains decodable only for service-level replay lookup", () => {
  const historical = {
    schemaVersion: 1,
    clientOperationId: "historical-approval",
    ...intent(),
  };
  assert.deepEqual(
    parseWebMcpApprovalCommand(historical, "inbox-one"),
    historical,
  );
});

test("preparation and consent reject route drift, digest drift, and open objects", () => {
  const withoutChallenge = Object.fromEntries(
    Object.entries(finalCommand()).filter(([key]) => key !== "challengeId"),
  );
  const withoutEvidence = Object.fromEntries(
    Object.entries(finalCommand()).filter(([key]) => key !== "evidenceDigest"),
  );
  const invalidFinal: unknown[] = [
    withoutChallenge,
    withoutEvidence,
    { ...finalCommand(), proposalDigest: "A".repeat(64) },
    { ...finalCommand(), evidenceDigest: "B".repeat(64) },
    { ...finalCommand(), challengeId: "A".repeat(42) },
    { ...finalCommand(), challengeId: `${"A".repeat(42)}+` },
    { ...finalCommand(), unexpected: true },
    {
      ...finalCommand(),
      duplicateDecision: { kind: "create_new", canonicalPaperId: "paper-one" },
    },
    { ...finalCommand(), duplicateDecision: { kind: "use_existing" } },
  ];
  for (const value of invalidFinal) {
    assert.throws(
      () => parseWebMcpApprovalCommand(value, "inbox-one"),
      (error: unknown) => error instanceof HttpProblem && error.code === "validation",
    );
  }
  assert.throws(
    () => parseWebMcpApprovalCommand(finalCommand(), "other-inbox"),
    (error: unknown) => error instanceof HttpProblem && error.code === "validation",
  );

  const preparation = { schemaVersion: 1, ...intent() };
  for (const value of [
    { ...preparation, schemaVersion: 2 },
    { ...preparation, unexpected: true },
    { ...preparation, proposalDigest: "a".repeat(63) },
  ]) {
    assert.throws(
      () => parseWebMcpApprovalPreparationCommand(value, "inbox-one"),
      (error: unknown) => error instanceof HttpProblem && error.code === "validation",
    );
  }
});
