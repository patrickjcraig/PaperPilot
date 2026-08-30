import "server-only";

import { createHash } from "node:crypto";
import type {
  WebEvidenceAgentAssertionV1,
  WebEvidenceAgentProposalV1,
  WebEvidenceArtifactV1,
  WebEvidenceCaptureEnvelopeV1,
  WebEvidenceFragmentV1,
  WebEvidenceFragmentDerivationV1,
  WebEvidenceJsonValue,
  WebEvidenceLocatorV1,
  WebEvidenceSourceToolV1,
  WebEvidenceSourceV1,
} from "@/lib/integrations/web-evidence-contract";
import { HttpProblem } from "@/server/http/problem";
import {
  canonicalizePublicWebSourceUrl,
  canonicalizeWebSourcePolicyOrigin,
} from "../web-source/url-policy";
import { canonicalWebMcpSnapshotJson } from "./snapshot-contract";

export const MAX_WEB_EVIDENCE_CAPTURE_COMMAND_BYTES = 128 * 1_024;
export const WEB_EVIDENCE_CAPTURE_DIGEST_DOMAIN =
  "paperpilot:webmcp:web-evidence-capture:v1\0";

const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "clientOperationId",
  "agent",
  "source",
  "artifact",
  "fragment",
  "agentProposal",
]);
const AGENT_KEYS = new Set([
  "kind",
  "runId",
  "providerLabel",
  "assertionAuthority",
]);
const SOURCE_KEYS = new Set([
  "url",
  "title",
  "observedAt",
  "language",
  "captureMethod",
  "sourceTool",
]);
const SOURCE_TOOL_KEYS = new Set([
  "origin",
  "name",
  "schemaVersion",
  "invocationId",
  "invokedAt",
  "input",
  "inputDigest",
  "output",
  "outputDigest",
]);
const ARTIFACT_KEYS = new Set([
  "scope",
  "mediaType",
  "rawText",
  "rawSha256",
]);
const FRAGMENT_KEYS = new Set([
  "exact",
  "prefix",
  "suffix",
  "quoteSha256",
  "locator",
  "derivation",
]);
const LOCATOR_KEYS = new Set([
  "textQuote",
  "textPosition",
  "cssSelector",
  "headingPath",
]);
const TEXT_QUOTE_KEYS = new Set(["exact", "prefix", "suffix"]);
const TEXT_POSITION_KEYS = new Set(["unit", "start", "end"]);
const SOURCE_DERIVATION_KEYS = new Set([
  "kind",
  "sourceOutputDigest",
  "sourceOutputPointer",
]);
const BROWSER_DERIVATION_KEYS = new Set(["kind"]);
const AGENT_PROPOSAL_KEYS = new Set(["claim"]);
const CAPTURE_METHODS = new Set([
  "source-webmcp-tool",
  "browser-agent-observation",
]);
const AGENT_KINDS = new Set<WebEvidenceAgentAssertionV1["kind"]>([
  "browser-integrated",
  "in-page",
  "extension",
  "unknown",
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const UNSAFE_STRUCTURED_TEXT_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;
const UNSAFE_EXACT_TEXT_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

function validation(message: string): never {
  throw new HttpProblem(400, "validation", message);
}

function exactRecord(
  value: unknown,
  label: string,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return validation(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unexpected) {
    validation(`${label} contains an unsupported field: ${unexpected}.`);
  }
  return record;
}

function requireOwn(
  record: Record<string, unknown>,
  label: string,
  requiredKeys: readonly string[],
): void {
  const missing = requiredKeys.find(
    (key) => !Object.prototype.hasOwnProperty.call(record, key),
  );
  if (missing) validation(`${label} is missing required field: ${missing}.`);
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function requiredStructuredText(
  value: unknown,
  label: string,
  maximumBytes: number,
): string {
  if (typeof value !== "string") validation(`${label} must be text.`);
  const normalized = value.trim();
  if (
    normalized.length === 0
    || utf8Length(normalized) > maximumBytes
    || UNSAFE_STRUCTURED_TEXT_PATTERN.test(normalized)
  ) {
    validation(`${label} is empty, unsafe, or exceeds ${maximumBytes} UTF-8 bytes.`);
  }
  return normalized;
}

function optionalStructuredText(
  value: unknown,
  label: string,
  maximumBytes: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") validation(`${label} must be text when provided.`);
  const normalized = value.trim();
  if (utf8Length(normalized) > maximumBytes || UNSAFE_STRUCTURED_TEXT_PATTERN.test(normalized)) {
    validation(`${label} is unsafe or exceeds ${maximumBytes} UTF-8 bytes.`);
  }
  return normalized || undefined;
}

function requiredExactText(
  value: unknown,
  label: string,
  maximumBytes: number,
): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || utf8Length(value) > maximumBytes
    || UNSAFE_EXACT_TEXT_PATTERN.test(value)
  ) {
    validation(`${label} is empty, unsafe, or exceeds ${maximumBytes} UTF-8 bytes.`);
  }
  return value;
}

function optionalExactText(
  value: unknown,
  label: string,
  maximumBytes: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string"
    || utf8Length(value) > maximumBytes
    || UNSAFE_EXACT_TEXT_PATTERN.test(value)
  ) {
    validation(`${label} is unsafe or exceeds ${maximumBytes} UTF-8 bytes.`);
  }
  return value || undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requiredSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    validation(`${label} must be 64 lowercase SHA-256 characters.`);
  }
  return value;
}

function normalizeJsonValue(
  value: unknown,
  label: string,
  depth = 0,
): WebEvidenceJsonValue {
  if (depth > 10) validation(`${label} exceeds the supported JSON depth.`);
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (
      typeof value === "string"
      && (utf8Length(value) > 32_000 || UNSAFE_EXACT_TEXT_PATTERN.test(value))
    ) {
      validation(`${label} contains unsafe or oversized JSON text.`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) validation(`${label} contains a non-finite number.`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) validation(`${label} contains too many JSON array items.`);
    return value.map((entry, index) =>
      normalizeJsonValue(entry, `${label}[${index}]`, depth + 1),
    );
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      validation(`${label} must contain JSON objects only.`);
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 100) validation(`${label} contains too many JSON object fields.`);
    const normalized: Record<string, WebEvidenceJsonValue> = {};
    for (const [key, entry] of entries) {
      if (
        key.length === 0
        || utf8Length(key) > 200
        || UNSAFE_STRUCTURED_TEXT_PATTERN.test(key)
      ) {
        validation(`${label} contains an invalid JSON object key.`);
      }
      // Define an own data property so JSON keys such as `__proto__` remain
      // exact retained content instead of invoking Object.prototype's legacy
      // setter and silently changing the normalized object's prototype.
      Object.defineProperty(normalized, key, {
        value: normalizeJsonValue(entry, `${label}.${key}`, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return normalized;
  }
  return validation(`${label} must be a JSON value.`);
}

function normalizeBoundedJson(
  value: unknown,
  label: string,
  maximumBytes: number,
): WebEvidenceJsonValue {
  const normalized = normalizeJsonValue(value, label);
  if (utf8Length(canonicalWebMcpSnapshotJson(normalized)) > maximumBytes) {
    validation(`${label} exceeds ${maximumBytes} canonical JSON bytes.`);
  }
  return normalized;
}

function jsonDigest(value: WebEvidenceJsonValue): string {
  return sha256(canonicalWebMcpSnapshotJson(value));
}

function resolveJsonPointer(
  value: WebEvidenceJsonValue,
  pointer: string,
): WebEvidenceJsonValue {
  if (!pointer.startsWith("/") || utf8Length(pointer) > 1_024) {
    validation("fragment.derivation.sourceOutputPointer must be a bounded JSON Pointer.");
  }
  let current = value;
  const segments = pointer.slice(1).split("/").map((raw) => {
    if (/~(?:[^01]|$)/.test(raw)) {
      validation("fragment.derivation.sourceOutputPointer contains an invalid escape.");
    }
    return raw.replace(/~1/g, "/").replace(/~0/g, "~");
  });
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(segment)) {
        validation("fragment.derivation.sourceOutputPointer has an invalid array index.");
      }
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= current.length) {
        validation("fragment.derivation.sourceOutputPointer does not resolve.");
      }
      current = current[index];
      continue;
    }
    if (current && typeof current === "object") {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        validation("fragment.derivation.sourceOutputPointer does not resolve.");
      }
      current = current[segment];
      continue;
    }
    validation("fragment.derivation.sourceOutputPointer does not resolve.");
  }
  return current;
}

function nonnegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    validation(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function canonicalSourceUrl(value: unknown): { url: string; origin: string } {
  let canonical: ReturnType<typeof canonicalizePublicWebSourceUrl>;
  try {
    canonical = canonicalizePublicWebSourceUrl(value);
  } catch {
    return validation("source.url must be an eligible public HTTPS URL.");
  }
  // V1 retains and later reopens the canonical source URL. A blacklist cannot
  // reliably distinguish benign parameters from bearer/share credentials, so
  // the minimum-safe contract admits only query-free public URLs.
  if (new URL(canonical.url).search !== "") {
    validation("source.url must be query-free in capture contract v1.");
  }
  return { url: canonical.url, origin: canonical.origin };
}

function canonicalSourceOrigin(value: unknown): string {
  try {
    return canonicalizeWebSourcePolicyOrigin(value);
  } catch {
    return validation("source.sourceTool.origin must be an eligible public HTTPS origin.");
  }
}

function normalizeClientTime(value: unknown, label: string, now: Date): string {
  if (typeof value !== "string" || value.length > 40) {
    validation(`${label} must be a bounded ISO date-time string.`);
  }
  const observed = new Date(value);
  if (
    !Number.isFinite(observed.getTime())
    || observed.getTime() < Date.UTC(2000, 0, 1)
    || observed.getTime() > now.getTime() + 5 * 60_000
  ) {
    validation(`${label} is outside the admitted client-time window.`);
  }
  return observed.toISOString();
}

function normalizeLanguage(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const raw = requiredStructuredText(value, "source.language", 100);
  try {
    return new Intl.Locale(raw).toString();
  } catch {
    return validation("source.language must be a valid language tag.");
  }
}

function normalizeAgent(value: unknown): WebEvidenceAgentAssertionV1 {
  const record = exactRecord(value, "agent", AGENT_KEYS);
  requireOwn(record, "agent", ["kind", "runId", "assertionAuthority"]);
  if (
    typeof record.kind !== "string"
    || !AGENT_KINDS.has(record.kind as WebEvidenceAgentAssertionV1["kind"])
  ) {
    validation("agent.kind is invalid.");
  }
  if (record.assertionAuthority !== "client-asserted") {
    validation("agent.assertionAuthority must be exactly client-asserted.");
  }
  const providerLabel = optionalStructuredText(
    record.providerLabel,
    "agent.providerLabel",
    200,
  );
  return {
    kind: record.kind as WebEvidenceAgentAssertionV1["kind"],
    runId: requiredStructuredText(record.runId, "agent.runId", 200),
    ...(providerLabel === undefined ? {} : { providerLabel }),
    assertionAuthority: "client-asserted",
  };
}

function normalizeArtifact(value: unknown): WebEvidenceArtifactV1 {
  const record = exactRecord(value, "artifact", ARTIFACT_KEYS);
  requireOwn(record, "artifact", ["scope", "mediaType", "rawText", "rawSha256"]);
  if (record.scope !== "bounded-fragment-context") {
    validation("artifact.scope must be exactly bounded-fragment-context.");
  }
  if (record.mediaType !== "text/plain;charset=utf-8") {
    validation("artifact.mediaType must be exactly text/plain;charset=utf-8.");
  }
  const rawText = requiredExactText(record.rawText, "artifact.rawText", 32_000);
  const suppliedDigest = requiredSha256(record.rawSha256, "artifact.rawSha256");
  const computedDigest = sha256(rawText);
  if (suppliedDigest !== computedDigest) {
    validation("artifact.rawSha256 does not match artifact.rawText.");
  }
  return {
    scope: "bounded-fragment-context",
    mediaType: "text/plain;charset=utf-8",
    rawText,
    rawSha256: computedDigest,
  };
}

function normalizeSourceTool(
  value: unknown,
  sourceOrigin: string,
  now: Date,
): WebEvidenceSourceToolV1 {
  const record = exactRecord(value, "source.sourceTool", SOURCE_TOOL_KEYS);
  requireOwn(record, "source.sourceTool", [
    "origin",
    "name",
    "invocationId",
    "invokedAt",
    "input",
    "inputDigest",
    "output",
    "outputDigest",
  ]);
  const origin = canonicalSourceOrigin(record.origin);
  if (origin !== sourceOrigin) {
    validation("source.sourceTool.origin must match the captured source origin.");
  }
  if (typeof record.name !== "string" || !TOOL_NAME_PATTERN.test(record.name)) {
    validation("source.sourceTool.name is invalid.");
  }
  const schemaVersion = optionalStructuredText(
    record.schemaVersion,
    "source.sourceTool.schemaVersion",
    100,
  );
  const input = normalizeBoundedJson(record.input, "source.sourceTool.input", 8_000);
  const output = normalizeBoundedJson(record.output, "source.sourceTool.output", 32_000);
  const suppliedInputDigest = requiredSha256(
    record.inputDigest,
    "source.sourceTool.inputDigest",
  );
  const suppliedOutputDigest = requiredSha256(
    record.outputDigest,
    "source.sourceTool.outputDigest",
  );
  const computedInputDigest = jsonDigest(input);
  const computedOutputDigest = jsonDigest(output);
  if (suppliedInputDigest !== computedInputDigest) {
    validation("source.sourceTool.inputDigest does not match the admitted input JSON.");
  }
  if (suppliedOutputDigest !== computedOutputDigest) {
    validation("source.sourceTool.outputDigest does not match the admitted output JSON.");
  }
  return {
    origin,
    name: record.name,
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
    invocationId: requiredStructuredText(
      record.invocationId,
      "source.sourceTool.invocationId",
      200,
    ),
    invokedAt: normalizeClientTime(
      record.invokedAt,
      "source.sourceTool.invokedAt",
      now,
    ),
    input,
    inputDigest: computedInputDigest,
    output,
    outputDigest: computedOutputDigest,
  };
}

function normalizeSource(value: unknown, now: Date): WebEvidenceSourceV1 {
  const record = exactRecord(value, "source", SOURCE_KEYS);
  requireOwn(record, "source", ["url", "title", "observedAt", "captureMethod"]);
  const canonical = canonicalSourceUrl(record.url);
  if (typeof record.captureMethod !== "string" || !CAPTURE_METHODS.has(record.captureMethod)) {
    validation("source.captureMethod is invalid.");
  }
  const sourceTool = record.sourceTool === undefined
    ? undefined
    : normalizeSourceTool(record.sourceTool, canonical.origin, now);
  if (record.captureMethod === "source-webmcp-tool" && !sourceTool) {
    validation("source.sourceTool is required for source-webmcp-tool captures.");
  }
  if (record.captureMethod === "browser-agent-observation" && sourceTool) {
    validation("source.sourceTool is not accepted for browser-agent-observation captures.");
  }
  const language = normalizeLanguage(record.language);
  return {
    url: canonical.url,
    title: requiredStructuredText(record.title, "source.title", 2_000),
    observedAt: normalizeClientTime(record.observedAt, "source.observedAt", now),
    ...(language === undefined ? {} : { language }),
    captureMethod: record.captureMethod as WebEvidenceSourceV1["captureMethod"],
    ...(sourceTool === undefined ? {} : { sourceTool }),
  };
}

function normalizeLocator(
  value: unknown,
  exact: string,
  prefix: string | undefined,
  suffix: string | undefined,
  artifact: WebEvidenceArtifactV1,
): WebEvidenceLocatorV1 {
  const record = exactRecord(value, "fragment.locator", LOCATOR_KEYS);
  requireOwn(record, "fragment.locator", ["textQuote", "textPosition"]);
  const quote = exactRecord(
    record.textQuote,
    "fragment.locator.textQuote",
    TEXT_QUOTE_KEYS,
  );
  requireOwn(quote, "fragment.locator.textQuote", ["exact"]);
  const quoteExact = requiredExactText(
    quote.exact,
    "fragment.locator.textQuote.exact",
    50_000,
  );
  const quotePrefix = optionalExactText(
    quote.prefix,
    "fragment.locator.textQuote.prefix",
    1_024,
  );
  const quoteSuffix = optionalExactText(
    quote.suffix,
    "fragment.locator.textQuote.suffix",
    1_024,
  );
  if (quoteExact !== exact || quotePrefix !== prefix || quoteSuffix !== suffix) {
    validation("fragment.locator.textQuote must exactly reproduce the admitted fragment.");
  }

  const position = exactRecord(
    record.textPosition,
    "fragment.locator.textPosition",
    TEXT_POSITION_KEYS,
  );
  requireOwn(position, "fragment.locator.textPosition", ["unit", "start", "end"]);
  if (position.unit !== "utf8-byte") {
    validation("fragment.locator.textPosition.unit must be exactly utf8-byte.");
  }
  const start = nonnegativeSafeInteger(
    position.start,
    "fragment.locator.textPosition.start",
  );
  const end = nonnegativeSafeInteger(
    position.end,
    "fragment.locator.textPosition.end",
  );
  if (end <= start) validation("fragment.locator.textPosition.end must exceed start.");
  const artifactBytes = Buffer.from(artifact.rawText, "utf8");
  if (end > artifactBytes.length) {
    validation("fragment.locator.textPosition exceeds the retained artifact.");
  }
  const selectedBytes = artifactBytes.subarray(start, end);
  const selectedText = selectedBytes.toString("utf8");
  if (
    selectedText !== exact
    || !Buffer.from(selectedText, "utf8").equals(selectedBytes)
  ) {
    validation("fragment.locator.textPosition does not reconstruct fragment.exact.");
  }
  const expectedStart = utf8Length(prefix ?? "");
  const expectedEnd = expectedStart + utf8Length(exact);
  if (start !== expectedStart || end !== expectedEnd) {
    validation("fragment.locator.textPosition does not match the retained context layout.");
  }
  const textPosition: WebEvidenceLocatorV1["textPosition"] = {
    unit: "utf8-byte",
    start,
    end,
  };

  const cssSelector = optionalStructuredText(
    record.cssSelector,
    "fragment.locator.cssSelector",
    1_000,
  );
  let headingPath: string[] | undefined;
  if (record.headingPath !== undefined) {
    if (!Array.isArray(record.headingPath) || record.headingPath.length > 16) {
      validation("fragment.locator.headingPath must contain at most 16 headings.");
    }
    headingPath = record.headingPath.map((heading, index) =>
      requiredStructuredText(
        heading,
        `fragment.locator.headingPath[${index}]`,
        500,
      ),
    );
  }

  return {
    textQuote: {
      exact: quoteExact,
      ...(quotePrefix === undefined ? {} : { prefix: quotePrefix }),
      ...(quoteSuffix === undefined ? {} : { suffix: quoteSuffix }),
    },
    textPosition,
    ...(cssSelector === undefined ? {} : { cssSelector }),
    ...(headingPath === undefined ? {} : { headingPath }),
  };
}

function normalizeDerivation(
  value: unknown,
  source: WebEvidenceSourceV1,
  artifact: WebEvidenceArtifactV1,
): WebEvidenceFragmentDerivationV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    validation("fragment.derivation must be an object.");
  }
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "source-tool-output-string") {
    const record = exactRecord(value, "fragment.derivation", SOURCE_DERIVATION_KEYS);
    requireOwn(record, "fragment.derivation", [
      "kind",
      "sourceOutputDigest",
      "sourceOutputPointer",
    ]);
    if (source.captureMethod !== "source-webmcp-tool" || !source.sourceTool) {
      validation("source-tool-output-string requires a source WebMCP tool capture.");
    }
    const digest = requiredSha256(
      record.sourceOutputDigest,
      "fragment.derivation.sourceOutputDigest",
    );
    if (digest !== source.sourceTool.outputDigest) {
      validation("fragment.derivation is not bound to the admitted source-tool output.");
    }
    const pointer = requiredExactText(
      record.sourceOutputPointer,
      "fragment.derivation.sourceOutputPointer",
      1_024,
    );
    const selectedOutput = resolveJsonPointer(source.sourceTool.output, pointer);
    if (selectedOutput !== artifact.rawText) {
      validation("The source-tool output pointer does not resolve to artifact.rawText.");
    }
    return {
      kind,
      sourceOutputDigest: digest,
      sourceOutputPointer: pointer,
    };
  }
  if (kind === "browser-visible-text") {
    exactRecord(value, "fragment.derivation", BROWSER_DERIVATION_KEYS);
    if (source.captureMethod !== "browser-agent-observation" || source.sourceTool) {
      validation("browser-visible-text requires a browser-agent observation.");
    }
    return { kind };
  }
  return validation("fragment.derivation.kind is invalid.");
}

function normalizeFragment(
  value: unknown,
  source: WebEvidenceSourceV1,
  artifact: WebEvidenceArtifactV1,
): WebEvidenceFragmentV1 {
  const record = exactRecord(value, "fragment", FRAGMENT_KEYS);
  requireOwn(record, "fragment", ["exact", "quoteSha256", "locator", "derivation"]);
  const exact = requiredExactText(record.exact, "fragment.exact", 50_000);
  const prefix = optionalExactText(record.prefix, "fragment.prefix", 1_024);
  const suffix = optionalExactText(record.suffix, "fragment.suffix", 1_024);
  const suppliedDigest = requiredSha256(record.quoteSha256, "fragment.quoteSha256");
  const computedDigest = sha256(exact);
  if (suppliedDigest !== computedDigest) {
    validation("fragment.quoteSha256 does not match fragment.exact.");
  }
  if (artifact.rawText !== `${prefix ?? ""}${exact}${suffix ?? ""}`) {
    validation("artifact.rawText must exactly equal fragment prefix, exact text, and suffix.");
  }
  return {
    exact,
    ...(prefix === undefined ? {} : { prefix }),
    ...(suffix === undefined ? {} : { suffix }),
    quoteSha256: computedDigest,
    locator: normalizeLocator(record.locator, exact, prefix, suffix, artifact),
    derivation: normalizeDerivation(record.derivation, source, artifact),
  };
}

function normalizeAgentProposal(value: unknown): WebEvidenceAgentProposalV1 {
  const record = exactRecord(value, "agentProposal", AGENT_PROPOSAL_KEYS);
  requireOwn(record, "agentProposal", ["claim"]);
  return {
    claim: requiredStructuredText(record.claim, "agentProposal.claim", 20_000),
  };
}

/**
 * Parses only untrusted browser/agent observations. Workspace, actor, receipt
 * time, acceptance state, and retained provenance authority are server-owned.
 */
export function parseWebEvidenceCaptureEnvelope(
  value: unknown,
  now = new Date(),
): WebEvidenceCaptureEnvelopeV1 {
  const record = exactRecord(value, "WebEvidenceCaptureEnvelopeV1", TOP_LEVEL_KEYS);
  requireOwn(record, "WebEvidenceCaptureEnvelopeV1", [
    "schemaVersion",
    "clientOperationId",
    "agent",
    "source",
    "artifact",
    "fragment",
    "agentProposal",
  ]);
  if (record.schemaVersion !== 1) {
    validation("WebEvidenceCaptureEnvelopeV1.schemaVersion must be exactly 1.");
  }
  const source = normalizeSource(record.source, now);
  const artifact = normalizeArtifact(record.artifact);
  return {
    schemaVersion: 1,
    clientOperationId: requiredStructuredText(
      record.clientOperationId,
      "clientOperationId",
      200,
    ),
    agent: normalizeAgent(record.agent),
    source,
    artifact,
    fragment: normalizeFragment(record.fragment, source, artifact),
    agentProposal: normalizeAgentProposal(record.agentProposal),
  };
}

export function webEvidenceCaptureDigest(
  envelope: WebEvidenceCaptureEnvelopeV1,
): string {
  const content = {
    schemaVersion: envelope.schemaVersion,
    agent: envelope.agent,
    source: envelope.source,
    artifact: envelope.artifact,
    fragment: envelope.fragment,
    agentProposal: envelope.agentProposal,
  };
  return sha256(
    WEB_EVIDENCE_CAPTURE_DIGEST_DOMAIN + canonicalWebMcpSnapshotJson(content),
  );
}
