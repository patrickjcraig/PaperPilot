import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import {
  OpenAlexLiteratureSearchProvider,
  OpenAlexProviderError,
} from "@/lib/integrations/openalex-adapter";
import type {
  LiteratureSearchFilters,
  LiteratureSearchRequest,
} from "@/lib/integrations/contracts";
import type { EvidenceStrength, PaperType } from "@/lib/types";
import { safeRequestId } from "@/lib/http/request-id";
import { sessionForRequest } from "@/server/auth/session";
import {
  consumeDiscoverRateLimit,
  rateLimitExceededResponse,
} from "@/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_QUERY_LENGTH = 1_000;
const MAX_ID_LENGTH = 200;
const MAX_FILTER_ITEMS = 20;
const MAX_TAG_LENGTH = 100;

const TOP_LEVEL_KEYS = new Set(["query", "requestId", "researchGoalId", "filters", "limit"]);
const FILTER_KEYS = new Set(["yearFrom", "yearTo", "paperTypes", "evidenceStrength", "tags"]);
const SUPPORTED_PAPER_TYPES = new Set<PaperType>([
  "journal article",
  "conference paper",
  "review",
]);
const EVIDENCE_STRENGTHS = new Set<EvidenceStrength>([
  "foundational",
  "strong",
  "promising",
  "contextual",
  "unassessed",
]);

class RequestValidationError extends Error {
  readonly status: number;
  readonly code: "invalid_request" | "unsupported_media_type" | "request_too_large";

  constructor(
    message: string,
    options: {
      status?: number;
      code?: "invalid_request" | "unsupported_media_type" | "request_too_large";
    } = {},
  ) {
    super(message);
    this.name = "RequestValidationError";
    this.status = options.status ?? 400;
    this.code = options.code ?? "invalid_request";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowedKeys: Set<string>,
  location: string,
): void {
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    throw new RequestValidationError(`Unknown ${location} field “${unknownKey}”.`);
  }
}

function optionalTrimmedString(
  value: unknown,
  fieldName: string,
  maximumLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new RequestValidationError(`${fieldName} must be a string.`);
  }

  const result = value.trim();
  if (!result) throw new RequestValidationError(`${fieldName} must not be empty.`);
  if (result.length > maximumLength) {
    throw new RequestValidationError(`${fieldName} must be ${maximumLength} characters or fewer.`);
  }
  return result;
}

function optionalInteger(
  value: unknown,
  fieldName: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RequestValidationError(
      `${fieldName} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value as number;
}

function validateArray(value: unknown, fieldName: string): unknown[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new RequestValidationError(`${fieldName} must be an array.`);
  if (value.length > MAX_FILTER_ITEMS) {
    throw new RequestValidationError(`${fieldName} may contain at most ${MAX_FILTER_ITEMS} values.`);
  }
  return value;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function parsePaperTypes(value: unknown): PaperType[] | undefined {
  const values = validateArray(value, "filters.paperTypes");
  if (!values) return undefined;

  return unique(
    values.map((item) => {
      if (typeof item !== "string" || !SUPPORTED_PAPER_TYPES.has(item as PaperType)) {
        throw new RequestValidationError(
          "filters.paperTypes currently supports only journal article, conference paper, and review for live OpenAlex search.",
        );
      }
      return item as PaperType;
    }),
  );
}

function parseEvidenceStrength(value: unknown): EvidenceStrength[] | undefined {
  const values = validateArray(value, "filters.evidenceStrength");
  if (!values) return undefined;

  return unique(
    values.map((item) => {
      if (typeof item !== "string" || !EVIDENCE_STRENGTHS.has(item as EvidenceStrength)) {
        throw new RequestValidationError(
          "filters.evidenceStrength contains an unsupported evidence-strength value.",
        );
      }
      return item as EvidenceStrength;
    }),
  );
}

function parseTags(value: unknown): string[] | undefined {
  const values = validateArray(value, "filters.tags");
  if (!values) return undefined;

  return unique(
    values.map((item) => {
      if (typeof item !== "string") {
        throw new RequestValidationError("Every filters.tags value must be a string.");
      }
      const tag = item.trim();
      if (!tag || tag.length > MAX_TAG_LENGTH) {
        throw new RequestValidationError(
          `Every filters.tags value must contain 1–${MAX_TAG_LENGTH} characters.`,
        );
      }
      return tag;
    }),
  );
}

function parseFilters(value: unknown): LiteratureSearchFilters | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new RequestValidationError("filters must be an object.");

  assertKnownKeys(value, FILTER_KEYS, "filters");
  const yearFrom = optionalInteger(value.yearFrom, "filters.yearFrom", 1_000, 3_000);
  const yearTo = optionalInteger(value.yearTo, "filters.yearTo", 1_000, 3_000);
  if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) {
    throw new RequestValidationError("filters.yearFrom must not be after filters.yearTo.");
  }

  return {
    yearFrom,
    yearTo,
    paperTypes: parsePaperTypes(value.paperTypes),
    evidenceStrength: parseEvidenceStrength(value.evidenceStrength),
    tags: parseTags(value.tags),
  };
}

async function parseSearchRequest(request: Request, fallbackRequestId: string): Promise<LiteratureSearchRequest> {
  const contentType = request.headers.get("content-type");
  if (contentType && !contentType.toLocaleLowerCase().includes("application/json")) {
    throw new RequestValidationError("The Discover endpoint accepts application/json requests.", {
      status: 415,
      code: "unsupported_media_type",
    });
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new RequestValidationError("The Discover request body is too large.", {
      status: 413,
      code: "request_too_large",
    });
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).length > MAX_REQUEST_BYTES) {
    throw new RequestValidationError("The Discover request body is too large.", {
      status: 413,
      code: "request_too_large",
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new RequestValidationError("The Discover request body must contain valid JSON.");
  }

  if (!isRecord(value)) throw new RequestValidationError("The Discover request body must be an object.");
  assertKnownKeys(value, TOP_LEVEL_KEYS, "request");

  if (typeof value.query !== "string") {
    throw new RequestValidationError("query must be a string.");
  }
  const query = value.query.trim();
  if (!query) throw new RequestValidationError("Enter a search query before running live discovery.");
  if (query.length > MAX_QUERY_LENGTH) {
    throw new RequestValidationError(
      `query must be ${MAX_QUERY_LENGTH} characters or fewer. Split larger Boolean searches into smaller requests.`,
    );
  }

  return {
    query,
    requestId: safeRequestId(
      optionalTrimmedString(value.requestId, "requestId", MAX_ID_LENGTH),
      fallbackRequestId,
    ),
    researchGoalId: optionalTrimmedString(value.researchGoalId, "researchGoalId", MAX_ID_LENGTH),
    filters: parseFilters(value.filters),
    limit: optionalInteger(value.limit, "limit", 1, 100),
  };
}

function errorResponse(
  status: number,
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId: string;
    providerStatus?: number;
    retryAfterSeconds?: number;
    retryAt?: string;
  },
): NextResponse {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Request-Id": error.requestId,
  });
  if (error.retryAfterSeconds !== undefined) {
    headers.set("Retry-After", String(Math.max(0, Math.ceil(error.retryAfterSeconds))));
  }

  return NextResponse.json(
    {
      error: {
        ...error,
        provider: "openalex",
      },
    },
    { status, headers },
  );
}

export async function POST(request: Request): Promise<Response> {
  const fallbackRequestId = `discover-${randomUUID()}`;
  let requestId = fallbackRequestId;

  try {
    const anonymousDiscoveryEnabled =
      process.env.NODE_ENV !== "production"
      && process.env.OPENALEX_ALLOW_ANONYMOUS === "true";
    const session = await sessionForRequest(request);
    if (!anonymousDiscoveryEnabled && !session) {
      return errorResponse(401, {
        code: "authentication_required",
        message: "Sign in to use the live scholarly discovery gateway.",
        retryable: false,
        requestId,
      });
    }

    const rateLimit = await consumeDiscoverRateLimit({
      request,
      userId: session?.user.id,
      workspaceId: session?.session.activeOrganizationId,
    });
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit, requestId);

    const searchRequest = await parseSearchRequest(request, fallbackRequestId);
    requestId = searchRequest.requestId ?? fallbackRequestId;
    const provider = new OpenAlexLiteratureSearchProvider();
    const response = await provider.search(searchRequest);

    return NextResponse.json(response, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "X-Request-Id": response.requestId,
      },
    });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return errorResponse(error.status, {
        code: error.code,
        message: error.message,
        retryable: false,
        requestId,
      });
    }

    if (error instanceof OpenAlexProviderError) {
      return errorResponse(error.status, {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        requestId: error.requestId ?? requestId,
        providerStatus: error.providerStatus,
        retryAfterSeconds: error.retryAfterSeconds,
        retryAt: error.retryAt,
      });
    }

    console.error("Unexpected live Discover failure", {
      requestId,
      error: error instanceof Error ? error.message : "Unknown error",
    });

    return errorResponse(500, {
      code: "internal_error",
      message: "PaperPilot could not complete live discovery because of an unexpected server error.",
      retryable: true,
      requestId,
    });
  }
}
