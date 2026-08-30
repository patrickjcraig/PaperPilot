export const WEB_EVIDENCE_CAPTURE_SCHEMA_VERSION = 1 as const;
export const WEB_EVIDENCE_CAPTURE_TOOL_NAME =
  "paperpilot.stage_web_evidence" as const;
export const WEB_EVIDENCE_CONTRACT_TOOL_NAME =
  "paperpilot.describe_capture_contract" as const;

export type WebEvidenceCaptureMethod =
  | "source-webmcp-tool"
  | "browser-agent-observation";

export type WebEvidenceConfidence =
  | "unspecified"
  | "high"
  | "medium"
  | "low";

export type WebEvidenceJsonValue =
  | null
  | boolean
  | number
  | string
  | WebEvidenceJsonValue[]
  | { [key: string]: WebEvidenceJsonValue };

export interface WebEvidenceAgentAssertionV1 {
  kind: "browser-integrated" | "in-page" | "extension" | "unknown";
  runId: string;
  providerLabel?: string;
  assertionAuthority: "client-asserted";
}

export interface WebEvidenceSourceToolV1 {
  origin: string;
  name: string;
  schemaVersion?: string;
  invocationId: string;
  invokedAt: string;
  input: WebEvidenceJsonValue;
  inputDigest: string;
  output: WebEvidenceJsonValue;
  outputDigest: string;
}

export interface WebEvidenceSourceV1 {
  url: string;
  title: string;
  observedAt: string;
  language?: string;
  captureMethod: WebEvidenceCaptureMethod;
  sourceTool?: WebEvidenceSourceToolV1;
}

export interface WebEvidenceTextQuoteSelectorV1 {
  exact: string;
  prefix?: string;
  suffix?: string;
}

export interface WebEvidenceTextPositionSelectorV1 {
  unit: "utf8-byte";
  start: number;
  end: number;
}

export interface WebEvidenceArtifactV1 {
  scope: "bounded-fragment-context";
  mediaType: "text/plain;charset=utf-8";
  rawText: string;
  rawSha256: string;
}

export type WebEvidenceFragmentDerivationV1 =
  | {
    kind: "source-tool-output-string";
    sourceOutputDigest: string;
    sourceOutputPointer: string;
  }
  | { kind: "browser-visible-text" };

export interface WebEvidenceLocatorV1 {
  textQuote: WebEvidenceTextQuoteSelectorV1;
  textPosition: WebEvidenceTextPositionSelectorV1;
  cssSelector?: string;
  headingPath?: string[];
}

export interface WebEvidenceFragmentV1 {
  exact: string;
  prefix?: string;
  suffix?: string;
  quoteSha256: string;
  locator: WebEvidenceLocatorV1;
  derivation: WebEvidenceFragmentDerivationV1;
}

export interface WebEvidenceAgentProposalV1 {
  claim: string;
}

export interface WebEvidenceCaptureEnvelopeV1 {
  schemaVersion: typeof WEB_EVIDENCE_CAPTURE_SCHEMA_VERSION;
  clientOperationId: string;
  agent: WebEvidenceAgentAssertionV1;
  source: WebEvidenceSourceV1;
  artifact: WebEvidenceArtifactV1;
  fragment: WebEvidenceFragmentV1;
  agentProposal: WebEvidenceAgentProposalV1;
}

const SHA256_PATTERN = "^[0-9a-f]{64}$";

/**
 * Browser-facing JSON Schema for the experimental WebMCP tool. The server
 * applies the same shape plus byte, URL, digest, and relationship checks.
 */
export const WEB_EVIDENCE_CAPTURE_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "clientOperationId",
    "agent",
    "source",
    "artifact",
    "fragment",
    "agentProposal",
  ],
  properties: {
    schemaVersion: { const: WEB_EVIDENCE_CAPTURE_SCHEMA_VERSION },
    clientOperationId: { type: "string", minLength: 1, maxLength: 200 },
    agent: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "runId", "assertionAuthority"],
      properties: {
        kind: {
          enum: ["browser-integrated", "in-page", "extension", "unknown"],
        },
        runId: { type: "string", minLength: 1, maxLength: 200 },
        providerLabel: { type: "string", minLength: 1, maxLength: 200 },
        assertionAuthority: { const: "client-asserted" },
      },
    },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["url", "title", "observedAt", "captureMethod"],
      properties: {
        url: { type: "string", format: "uri", maxLength: 2_048 },
        title: { type: "string", minLength: 1, maxLength: 2_000 },
        observedAt: { type: "string", format: "date-time", maxLength: 40 },
        language: { type: "string", minLength: 2, maxLength: 100 },
        captureMethod: {
          enum: ["source-webmcp-tool", "browser-agent-observation"],
        },
        sourceTool: {
          type: "object",
          additionalProperties: false,
          required: [
            "origin",
            "name",
            "invocationId",
            "invokedAt",
            "input",
            "inputDigest",
            "output",
            "outputDigest",
          ],
          properties: {
            origin: { type: "string", format: "uri", maxLength: 255 },
            name: {
              type: "string",
              minLength: 1,
              maxLength: 128,
              pattern: "^[A-Za-z0-9_.-]+$",
            },
            schemaVersion: { type: "string", minLength: 1, maxLength: 100 },
            invocationId: { type: "string", minLength: 1, maxLength: 200 },
            invokedAt: { type: "string", format: "date-time", maxLength: 40 },
            input: {},
            inputDigest: { type: "string", pattern: SHA256_PATTERN },
            output: {},
            outputDigest: { type: "string", pattern: SHA256_PATTERN },
          },
        },
      },
    },
    artifact: {
      type: "object",
      additionalProperties: false,
      required: ["scope", "mediaType", "rawText", "rawSha256"],
      properties: {
        scope: { const: "bounded-fragment-context" },
        mediaType: { const: "text/plain;charset=utf-8" },
        rawText: { type: "string", minLength: 1, maxLength: 32_000 },
        rawSha256: { type: "string", pattern: SHA256_PATTERN },
      },
    },
    fragment: {
      type: "object",
      additionalProperties: false,
      required: ["exact", "quoteSha256", "locator", "derivation"],
      properties: {
        exact: { type: "string", minLength: 1, maxLength: 50_000 },
        prefix: { type: "string", maxLength: 1_024 },
        suffix: { type: "string", maxLength: 1_024 },
        quoteSha256: { type: "string", pattern: SHA256_PATTERN },
        locator: {
          type: "object",
          additionalProperties: false,
          required: ["textQuote", "textPosition"],
          properties: {
            textQuote: {
              type: "object",
              additionalProperties: false,
              required: ["exact"],
              properties: {
                exact: { type: "string", minLength: 1, maxLength: 50_000 },
                prefix: { type: "string", maxLength: 1_024 },
                suffix: { type: "string", maxLength: 1_024 },
              },
            },
            textPosition: {
              type: "object",
              additionalProperties: false,
              required: ["unit", "start", "end"],
              properties: {
                unit: { const: "utf8-byte" },
                start: { type: "integer", minimum: 0 },
                end: { type: "integer", minimum: 1 },
              },
            },
            cssSelector: { type: "string", minLength: 1, maxLength: 1_000 },
            headingPath: {
              type: "array",
              maxItems: 16,
              items: { type: "string", minLength: 1, maxLength: 500 },
            },
          },
        },
        derivation: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "sourceOutputDigest", "sourceOutputPointer"],
              properties: {
                kind: { const: "source-tool-output-string" },
                sourceOutputDigest: { type: "string", pattern: SHA256_PATTERN },
                sourceOutputPointer: { type: "string", minLength: 1, maxLength: 1_024 },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["kind"],
              properties: {
                kind: { const: "browser-visible-text" },
              },
            },
          ],
        },
      },
    },
    agentProposal: {
      type: "object",
      additionalProperties: false,
      required: ["claim"],
      properties: {
        claim: { type: "string", minLength: 1, maxLength: 20_000 },
      },
    },
  },
  allOf: [
    {
      if: {
        properties: {
          source: {
            properties: { captureMethod: { const: "source-webmcp-tool" } },
            required: ["captureMethod"],
          },
        },
      },
      then: {
        properties: {
          source: { required: ["sourceTool"] },
        },
      },
    },
  ],
} as const;
