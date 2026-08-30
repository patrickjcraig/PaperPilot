import "server-only";

import type { Collection } from "@/lib/types";
import type { CreateCollectionCommand } from "@/lib/workspace";
import { HttpProblem } from "@/server/http/problem";

const COMMAND_KEYS = new Set([
  "clientOperationId",
  "expectedVersion",
  "projectId",
  "name",
  "description",
  "color",
]);
const COLORS = new Set<Collection["color"]>(["blue", "amber", "slate", "teal"]);

function validation(message: string): never {
  throw new HttpProblem(400, "validation", message);
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") validation(`${label} must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    validation(`${label} must contain 1 to ${maximum.toLocaleString()} characters.`);
  }
  return normalized;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") validation(`${label} must be text.`);
  const normalized = value.trim();
  if (normalized.length > maximum) {
    validation(`${label} may contain at most ${maximum.toLocaleString()} characters.`);
  }
  return normalized;
}

export function validateCreateCollectionCommand(raw: unknown): CreateCollectionCommand {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    validation("A collection command object is required.");
  }
  const record = raw as Record<string, unknown>;
  const unexpected = Object.keys(record).find((key) => !COMMAND_KEYS.has(key));
  if (unexpected) validation(`Collection command contains an unsupported field: ${unexpected}.`);

  const clientOperationId = requiredText(
    record.clientOperationId,
    "clientOperationId",
    200,
  );
  if (!Number.isSafeInteger(record.expectedVersion) || (record.expectedVersion as number) < 0) {
    validation("expectedVersion must be a non-negative integer.");
  }
  const projectId = requiredText(record.projectId, "projectId", 200);
  const name = requiredText(record.name, "Collection name", 120);
  const description = boundedText(record.description, "Collection description", 5_000);
  if (typeof record.color !== "string" || !COLORS.has(record.color as Collection["color"])) {
    validation("Collection color must be blue, amber, slate, or teal.");
  }

  return {
    clientOperationId,
    expectedVersion: record.expectedVersion as number,
    projectId,
    name,
    description,
    color: record.color as Collection["color"],
  };
}

export function applyCollectionIdempotencyHeader(request: Request, body: unknown): unknown {
  const headerOperationId = request.headers.get("idempotency-key")?.trim();
  if (!headerOperationId) return body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    validation("A collection command object is required.");
  }
  const record = body as Record<string, unknown>;
  if (
    record.clientOperationId !== undefined
    && record.clientOperationId !== headerOperationId
  ) {
    throw new HttpProblem(
      400,
      "idempotency_mismatch",
      "Idempotency-Key must match clientOperationId.",
    );
  }
  return { ...record, clientOperationId: headerOperationId };
}
