import {
  WEB_EVIDENCE_CAPTURE_INPUT_SCHEMA,
  WEB_EVIDENCE_CAPTURE_TOOL_NAME,
  WEB_EVIDENCE_CONTRACT_TOOL_NAME,
  type WebEvidenceCaptureEnvelopeV1,
} from "./web-evidence-contract";

export const WEB_EVIDENCE_CONTRACT_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

/** The read-only result can include user-controlled workspace/project labels. */
export const WEB_EVIDENCE_CONTRACT_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  untrustedContentHint: true,
} as const;

/** Staging mutates PaperPilot and ingests webpage text that remains untrusted. */
export const WEB_EVIDENCE_CAPTURE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  untrustedContentHint: true,
} as const;

export interface PaperPilotWebMcpExecutionContext {
  signal: AbortSignal;
}

export interface PaperPilotWebMcpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
  annotations: {
    readOnlyHint: boolean;
    untrustedContentHint: boolean;
  };
  execute: (
    input: unknown,
    context: PaperPilotWebMcpExecutionContext,
  ) => unknown | PromiseLike<unknown>;
}

export interface PaperPilotWebMcpModelContext {
  registerTool: (
    tool: PaperPilotWebMcpToolDefinition,
    options: { signal: AbortSignal },
  ) => unknown | PromiseLike<unknown>;
}

export interface PaperPilotWebMcpDocument {
  readonly modelContext?: unknown;
}

export interface PaperPilotWebEvidenceToolCallbacks {
  describeCaptureContract: (
    context: PaperPilotWebMcpExecutionContext,
  ) => unknown | PromiseLike<unknown>;
  stageWebEvidence: (
    envelope: WebEvidenceCaptureEnvelopeV1,
    context: PaperPilotWebMcpExecutionContext,
  ) => unknown | PromiseLike<unknown>;
}

export interface RegisterPaperPilotWebEvidenceToolsOptions
  extends PaperPilotWebEvidenceToolCallbacks {
  /** Defaults to the ambient browser document. Pass a structural fake in tests. */
  document?: PaperPilotWebMcpDocument | null;
}

export type PaperPilotWebMcpCapability =
  | {
      status: "available";
      modelContext: PaperPilotWebMcpModelContext;
    }
  | {
      status: "unavailable";
      reason: "document_unavailable" | "model_context_unavailable";
      message: string;
    }
  | {
      status: "error";
      reason: "capability_check_failed";
      message: string;
      cause: unknown;
    };

interface PaperPilotWebMcpRegistrationBase {
  message: string;
  /** Aborts the shared registration signal and is safe to call repeatedly. */
  dispose: () => void;
}

export type PaperPilotWebMcpRegistration =
  | (PaperPilotWebMcpRegistrationBase & {
      status: "registered";
    })
  | (PaperPilotWebMcpRegistrationBase & {
      status: "unavailable";
      reason: "document_unavailable" | "model_context_unavailable";
    })
  | (PaperPilotWebMcpRegistrationBase & {
      status: "error";
      reason: "capability_check_failed" | "registration_failed";
      cause: unknown;
    });

function noOp(): void {
  // All registration outcomes expose one framework-friendly cleanup shape.
}

function ambientDocument(): PaperPilotWebMcpDocument | undefined {
  return typeof document === "undefined"
    ? undefined
    : document as unknown as PaperPilotWebMcpDocument;
}

function objectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/**
 * Detect the current imperative WebMCP registration surface without augmenting
 * global DOM types or treating a throwing experimental getter as unsupported.
 */
export function detectPaperPilotWebMcpCapability(
  targetDocument: PaperPilotWebMcpDocument | null | undefined = ambientDocument(),
): PaperPilotWebMcpCapability {
  if (!targetDocument) {
    return {
      status: "unavailable",
      reason: "document_unavailable",
      message: "WebMCP tool registration is unavailable outside a browser document.",
    };
  }

  try {
    const modelContext = targetDocument.modelContext;
    if (!objectLike(modelContext)) {
      return {
        status: "unavailable",
        reason: "model_context_unavailable",
        message: "This browser does not expose document.modelContext.registerTool.",
      };
    }
    const registerTool = Reflect.get(modelContext, "registerTool");
    if (typeof registerTool !== "function") {
      return {
        status: "unavailable",
        reason: "model_context_unavailable",
        message: "This browser does not expose document.modelContext.registerTool.",
      };
    }
    return {
      status: "available",
      modelContext: {
        registerTool: (tool, options) => Reflect.apply(
          registerTool,
          modelContext,
          [tool, options],
        ) as unknown,
      },
    };
  } catch (cause) {
    return {
      status: "error",
      reason: "capability_check_failed",
      message: "PaperPilot could not inspect this browser's WebMCP capability.",
      cause,
    };
  }
}

/** Build the two current WebMCP tool definitions without registering them. */
export function paperPilotWebEvidenceToolDefinitions(
  callbacks: PaperPilotWebEvidenceToolCallbacks,
): readonly [PaperPilotWebMcpToolDefinition, PaperPilotWebMcpToolDefinition] {
  return [
    {
      name: WEB_EVIDENCE_CONTRACT_TOOL_NAME,
      title: "Describe PaperPilot web evidence capture",
      description: "Describe PaperPilot's bounded web evidence capture contract and visible destinations without changing workspace state.",
      inputSchema: WEB_EVIDENCE_CONTRACT_INPUT_SCHEMA,
      annotations: WEB_EVIDENCE_CONTRACT_TOOL_ANNOTATIONS,
      execute: (_input, context) => callbacks.describeCaptureContract(context),
    },
    {
      name: WEB_EVIDENCE_CAPTURE_TOOL_NAME,
      title: "Stage web evidence in PaperPilot",
      description: "Stage one bounded webpage passage for explicit human review.",
      inputSchema: WEB_EVIDENCE_CAPTURE_INPUT_SCHEMA,
      annotations: WEB_EVIDENCE_CAPTURE_TOOL_ANNOTATIONS,
      execute: (input, context) => callbacks.stageWebEvidence(
        input as WebEvidenceCaptureEnvelopeV1,
        context,
      ),
    },
  ];
}

/**
 * Register PaperPilot's progressive-enhancement tool surface. This function
 * performs no networking: application behavior enters only through callbacks.
 */
export async function registerPaperPilotWebEvidenceTools(
  options: RegisterPaperPilotWebEvidenceToolsOptions,
): Promise<PaperPilotWebMcpRegistration> {
  const capability = detectPaperPilotWebMcpCapability(
    options.document === undefined ? ambientDocument() : options.document,
  );
  if (capability.status === "unavailable") {
    return { ...capability, dispose: noOp };
  }
  if (capability.status === "error") {
    return { ...capability, dispose: noOp };
  }

  const controller = new AbortController();
  const dispose = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  const definitions = paperPilotWebEvidenceToolDefinitions(options);

  try {
    for (const definition of definitions) {
      await capability.modelContext.registerTool(definition, {
        signal: controller.signal,
      });
    }
    return {
      status: "registered",
      message: "PaperPilot WebMCP capture tools are registered.",
      dispose,
    };
  } catch (cause) {
    // A single signal owns both tools, so partial registration cannot survive.
    dispose();
    return {
      status: "error",
      reason: "registration_failed",
      message: "WebMCP is available, but PaperPilot could not register its capture tools.",
      cause,
      dispose,
    };
  }
}
