import assert from "node:assert/strict";
import test from "node:test";

import {
  WEB_EVIDENCE_CAPTURE_INPUT_SCHEMA,
  WEB_EVIDENCE_CAPTURE_TOOL_NAME,
  WEB_EVIDENCE_CONTRACT_TOOL_NAME,
  type WebEvidenceCaptureEnvelopeV1,
} from "./web-evidence-contract";
import {
  WEB_EVIDENCE_CAPTURE_TOOL_ANNOTATIONS,
  WEB_EVIDENCE_CONTRACT_INPUT_SCHEMA,
  WEB_EVIDENCE_CONTRACT_TOOL_ANNOTATIONS,
  detectPaperPilotWebMcpCapability,
  registerPaperPilotWebEvidenceTools,
  type PaperPilotWebMcpModelContext,
  type PaperPilotWebMcpToolDefinition,
} from "./web-evidence-browser-adapter";

interface RegistrationAttempt {
  tool: PaperPilotWebMcpToolDefinition;
  signal: AbortSignal;
}

class FakeModelContext implements PaperPilotWebMcpModelContext {
  readonly attempts: RegistrationAttempt[] = [];
  readonly activeTools = new Map<string, PaperPilotWebMcpToolDefinition>();
  failOnName?: string;
  failure = new Error("fake registration failure");

  async registerTool(
    tool: PaperPilotWebMcpToolDefinition,
    options: { signal: AbortSignal },
  ): Promise<void> {
    this.attempts.push({ tool, signal: options.signal });
    if (tool.name === this.failOnName) throw this.failure;
    if (options.signal.aborted) throw options.signal.reason;
    this.activeTools.set(tool.name, tool);
    options.signal.addEventListener("abort", () => {
      this.activeTools.delete(tool.name);
    }, { once: true });
  }

  execute(name: string, input: unknown, signal: AbortSignal): unknown | PromiseLike<unknown> {
    const tool = this.activeTools.get(name);
    if (!tool) throw new Error(`Tool is not registered: ${name}`);
    return tool.execute(input, { signal });
  }
}

function captureEnvelope(): WebEvidenceCaptureEnvelopeV1 {
  const rawText = "Context before. The bounded result improved. Context after.";
  const exact = "The bounded result improved.";
  return {
    schemaVersion: 1,
    clientOperationId: "web-evidence-operation-1",
    agent: {
      kind: "browser-integrated",
      runId: "agent-run-1",
      assertionAuthority: "client-asserted",
    },
    source: {
      url: "https://example.test/article",
      title: "Bounded result",
      observedAt: "2026-08-29T18:00:00.000Z",
      captureMethod: "browser-agent-observation",
    },
    artifact: {
      scope: "bounded-fragment-context",
      mediaType: "text/plain;charset=utf-8",
      rawText,
      rawSha256: "a".repeat(64),
    },
    fragment: {
      exact,
      prefix: "Context before. ",
      suffix: " Context after.",
      quoteSha256: "b".repeat(64),
      locator: {
        textQuote: {
          exact,
          prefix: "Context before. ",
          suffix: " Context after.",
        },
        textPosition: {
          unit: "utf8-byte",
          start: 16,
          end: 44,
        },
      },
      derivation: { kind: "browser-visible-text" },
    },
    agentProposal: {
      claim: "The source reports an improved bounded result.",
    },
  };
}

test("capability detection distinguishes unsupported and broken browser surfaces", () => {
  assert.deepEqual(detectPaperPilotWebMcpCapability(null), {
    status: "unavailable",
    reason: "document_unavailable",
    message: "WebMCP tool registration is unavailable outside a browser document.",
  });
  assert.deepEqual(detectPaperPilotWebMcpCapability({}), {
    status: "unavailable",
    reason: "model_context_unavailable",
    message: "This browser does not expose document.modelContext.registerTool.",
  });
  assert.deepEqual(detectPaperPilotWebMcpCapability({ modelContext: {} }), {
    status: "unavailable",
    reason: "model_context_unavailable",
    message: "This browser does not expose document.modelContext.registerTool.",
  });

  const expected = new Error("experimental getter failed");
  const capability = detectPaperPilotWebMcpCapability({
    get modelContext(): never {
      throw expected;
    },
  });
  assert.equal(capability.status, "error");
  if (capability.status === "error") {
    assert.equal(capability.reason, "capability_check_failed");
    assert.equal(capability.cause, expected);
  }
});

test("registration exposes the exact current tools, schemas, and annotations", async () => {
  const modelContext = new FakeModelContext();
  const description = {
    schemaVersion: 1,
    distinction: "Staging requires later human review.",
  };
  const staged = { status: "pending", stageId: "stage-1" };
  const describedSignals: AbortSignal[] = [];
  const stagedInputs: WebEvidenceCaptureEnvelopeV1[] = [];
  const stagedSignals: AbortSignal[] = [];
  const registration = await registerPaperPilotWebEvidenceTools({
    document: { modelContext },
    describeCaptureContract: ({ signal }) => {
      describedSignals.push(signal);
      return description;
    },
    stageWebEvidence: (input, { signal }) => {
      stagedInputs.push(input);
      stagedSignals.push(signal);
      return staged;
    },
  });

  assert.equal(registration.status, "registered");
  assert.deepEqual(
    modelContext.attempts.map(({ tool }) => tool.name),
    [WEB_EVIDENCE_CONTRACT_TOOL_NAME, WEB_EVIDENCE_CAPTURE_TOOL_NAME],
  );
  const [describeAttempt, stageAttempt] = modelContext.attempts;
  assert.ok(describeAttempt);
  assert.ok(stageAttempt);
  assert.equal(describeAttempt.signal, stageAttempt.signal);
  assert.equal(describeAttempt.signal.aborted, false);
  assert.equal(describeAttempt.tool.title, "Describe PaperPilot web evidence capture");
  assert.equal(
    describeAttempt.tool.description,
    "Describe PaperPilot's bounded web evidence capture contract and visible destinations without changing workspace state.",
  );
  assert.equal(describeAttempt.tool.inputSchema, WEB_EVIDENCE_CONTRACT_INPUT_SCHEMA);
  assert.deepEqual(describeAttempt.tool.annotations, {
    readOnlyHint: true,
    untrustedContentHint: true,
  });
  assert.deepEqual(describeAttempt.tool.annotations, WEB_EVIDENCE_CONTRACT_TOOL_ANNOTATIONS);

  assert.equal(stageAttempt.tool.title, "Stage web evidence in PaperPilot");
  assert.equal(
    stageAttempt.tool.description,
    "Stage one bounded webpage passage for explicit human review.",
  );
  assert.equal(stageAttempt.tool.inputSchema, WEB_EVIDENCE_CAPTURE_INPUT_SCHEMA);
  assert.deepEqual(stageAttempt.tool.annotations, {
    readOnlyHint: false,
    untrustedContentHint: true,
  });
  assert.deepEqual(stageAttempt.tool.annotations, WEB_EVIDENCE_CAPTURE_TOOL_ANNOTATIONS);

  const describeExecution = new AbortController();
  assert.equal(
    await modelContext.execute(
      WEB_EVIDENCE_CONTRACT_TOOL_NAME,
      {},
      describeExecution.signal,
    ),
    description,
  );
  assert.deepEqual(describedSignals, [describeExecution.signal]);

  const envelope = captureEnvelope();
  const stageExecution = new AbortController();
  assert.equal(
    await modelContext.execute(
      WEB_EVIDENCE_CAPTURE_TOOL_NAME,
      envelope,
      stageExecution.signal,
    ),
    staged,
  );
  assert.deepEqual(stagedInputs, [envelope]);
  assert.deepEqual(stagedSignals, [stageExecution.signal]);

  registration.dispose();
  registration.dispose();
  assert.equal(describeAttempt.signal.aborted, true);
  assert.equal(modelContext.activeTools.size, 0);
});

test("a registration failure aborts every partially registered tool", async () => {
  const modelContext = new FakeModelContext();
  modelContext.failOnName = WEB_EVIDENCE_CAPTURE_TOOL_NAME;
  const registration = await registerPaperPilotWebEvidenceTools({
    document: { modelContext },
    describeCaptureContract: () => ({}),
    stageWebEvidence: () => ({}),
  });

  assert.equal(registration.status, "error");
  if (registration.status === "error") {
    assert.equal(registration.reason, "registration_failed");
    assert.equal(registration.cause, modelContext.failure);
  }
  assert.equal(modelContext.attempts.length, 2);
  assert.equal(modelContext.attempts[0]?.signal, modelContext.attempts[1]?.signal);
  assert.equal(modelContext.attempts[0]?.signal.aborted, true);
  assert.equal(modelContext.activeTools.size, 0);
  registration.dispose();
});

test("callback failures remain failed tool executions", async () => {
  const modelContext = new FakeModelContext();
  const expected = new Error("staging callback failed");
  const registration = await registerPaperPilotWebEvidenceTools({
    document: { modelContext },
    describeCaptureContract: () => ({}),
    stageWebEvidence: async () => {
      throw expected;
    },
  });
  assert.equal(registration.status, "registered");

  await assert.rejects(
    Promise.resolve(modelContext.execute(
      WEB_EVIDENCE_CAPTURE_TOOL_NAME,
      captureEnvelope(),
      new AbortController().signal,
    )),
    (cause) => cause === expected,
  );
  registration.dispose();
});

test("unsupported browsers return unavailable without invoking callbacks", async () => {
  let callbackCalls = 0;
  const registration = await registerPaperPilotWebEvidenceTools({
    document: {},
    describeCaptureContract: () => {
      callbackCalls += 1;
    },
    stageWebEvidence: () => {
      callbackCalls += 1;
    },
  });

  assert.equal(registration.status, "unavailable");
  if (registration.status === "unavailable") {
    assert.equal(registration.reason, "model_context_unavailable");
  }
  assert.equal(callbackCalls, 0);
  assert.doesNotThrow(() => registration.dispose());
});
