import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { HttpProblem } from "@/server/http/problem";
import type { UploadConfiguration } from "./config";
import {
  IncrementalPdfEnvelopeValidator,
  parseContentLengthHeader,
  requireExactPdfContentType,
  type SupportedPdfVersion,
} from "./validation";

const STORAGE_KEY_V2_PREFIX = "local-quarantine-v2";
const STORAGE_KEY_V1_PATTERN = /^local-quarantine-v1:([a-f0-9]{64}):([a-f0-9]{64})$/;
const STORAGE_KEY_V2_PATTERN = /^local-quarantine-v2:([a-f0-9]{64}):([a-f0-9]{64}):([a-f0-9]{64})$/;
const LEGACY_FINAL_FILE_NAME = "original.quarantine";
const MAX_OPAQUE_ID_BYTES = 1_024;
const STORAGE_AUTHORITY_FILE_NAME = ".paperpilot-local-quarantine-authority-v1";
const STORAGE_AUTHORITY_DOMAIN = "paperpilot:local-quarantine:authority:v1\0";
const CUSTODY_TOMBSTONE_DOMAIN = "paperpilot:local-quarantine:custody-tombstone:v1\0";
const STORAGE_AUTHORITY_PATTERN = /^[a-f0-9]{64}$/;
const CUSTODY_TOMBSTONE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_CONTROL_FILE_BYTES = 4_096;
const MAX_CUSTODY_RETIRE_LOOPS = 16;

type LocalQuarantineStreamConfiguration = Pick<
  UploadConfiguration,
  | "quarantineRoot"
  | "maxUploadBytes"
  | "streamIdleTimeoutMs"
  | "streamAbsoluteTimeoutMs"
>;

interface LocalQuarantineTarget {
  organizationId: string;
  assetId: string;
  attemptId: string;
  expectedSizeBytes: bigint;
}

export interface LocalQuarantineStreamInput extends LocalQuarantineTarget {
  /** A byte stream whose source and read authority were already verified. */
  body: ReadableStream<Uint8Array>;
  configuration: LocalQuarantineStreamConfiguration;
  /** Canonical lowercase provider digest, when the source supplies one. */
  expectedMd5?: string;
  /** Immutable root generation admitted by the durable crawler lease. */
  expectedStorageAuthorityGeneration?: string;
  /** Optional caller/lease cancellation, independent of stream deadlines. */
  signal?: AbortSignal;
}

export interface LocalQuarantineUploadInput extends LocalQuarantineTarget {
  request: Request;
  configuration: LocalQuarantineStreamConfiguration;
}

export interface LocalQuarantineUploadResult {
  /** Opaque application storage key, not a filesystem path. */
  storageKey: string;
  sizeBytes: bigint;
  sha256: string;
  /** Content digest for provider-integrity comparison, never storage identity. */
  md5: string;
  mimeType: "application/pdf";
  pdfVersion: SupportedPdfVersion;
  /** Immutable identity of the canonical quarantine root that stored bytes. */
  storageAuthorityGeneration: string;
}

interface StorageSegments {
  organization: string;
  asset: string;
}

interface DecodedStorageKey extends StorageSegments {
  version: 1 | 2;
  attempt?: string;
}

export interface LocalQuarantineObjectIdentity {
  organizationId: string;
  assetId: string;
}

export interface LocalQuarantineStorageAuthority {
  schemaVersion: 1;
  generation: string;
}

export interface LocalQuarantineCustodyDeletionProof {
  schemaVersion: 1;
  storageAuthorityGeneration: string;
  tombstoneDigest: string;
}

export interface OpenLocalQuarantineObject {
  /** The already-verified handle; consumers must never reopen an OS path. */
  handle: FileHandle;
  sizeBytes: bigint;
  storageKey: string;
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function safeStorageFailure(): HttpProblem {
  return new HttpProblem(
    503,
    "storage_unavailable",
    "The upload could not be stored in quarantine.",
  );
}

function boundedOpaqueId(value: string, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_OPAQUE_ID_BYTES
  ) {
    throw new HttpProblem(400, "invalid_upload_target", `${label} is invalid.`);
  }
  return value;
}

function storageSegment(namespace: string, value: string): string {
  return createHash("sha256")
    .update(`paperpilot-${namespace}\0`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function storageSegments(organizationId: string, assetId: string): StorageSegments {
  return {
    organization: storageSegment(
      "quarantine-organization-v1",
      boundedOpaqueId(organizationId, "organizationId"),
    ),
    asset: storageSegment(
      "quarantine-asset-v1",
      boundedOpaqueId(assetId, "assetId"),
    ),
  };
}

function storageKeyFor(segments: StorageSegments, attempt: string): string {
  return `${STORAGE_KEY_V2_PREFIX}:${segments.organization}:${segments.asset}:${attempt}`;
}

export function localQuarantineStorageKeyForAttempt(
  identity: LocalQuarantineObjectIdentity,
  attemptId: string,
): string {
  const segments = storageSegments(identity.organizationId, identity.assetId);
  const attempt = storageSegment(
    "quarantine-attempt-v1",
    boundedOpaqueId(attemptId, "attemptId"),
  );
  return storageKeyFor(segments, attempt);
}

function decodeStorageKey(storageKey: string): DecodedStorageKey {
  const current = STORAGE_KEY_V2_PATTERN.exec(storageKey);
  if (current) {
    return {
      version: 2,
      organization: current[1],
      asset: current[2],
      attempt: current[3],
    };
  }
  const legacy = STORAGE_KEY_V1_PATTERN.exec(storageKey);
  if (legacy) {
    return { version: 1, organization: legacy[1], asset: legacy[2] };
  }
  throw new HttpProblem(
    400,
    "invalid_storage_key",
    "The quarantine storage key is invalid.",
  );
}

function requireStorageKeyIdentity(
  decoded: DecodedStorageKey,
  identity: LocalQuarantineObjectIdentity,
): void {
  const expected = storageSegments(identity.organizationId, identity.assetId);
  if (
    decoded.organization !== expected.organization
    || decoded.asset !== expected.asset
  ) {
    throw new HttpProblem(
      409,
      "storage_key_mismatch",
      "The quarantine object does not belong to the expected asset.",
    );
  }
}

function finalFileName(decoded: DecodedStorageKey): string {
  return decoded.version === 1
    ? LEGACY_FINAL_FILE_NAME
    : `${decoded.attempt}.quarantine`;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function containedPath(root: string, ...segments: string[]): string {
  const candidate = path.resolve(root, ...segments);
  if (!isWithin(root, candidate) || candidate === root) throw safeStorageFailure();
  return candidate;
}

async function privateRoot(root: string, create: boolean): Promise<string | null> {
  if (!path.isAbsolute(root) || root === path.parse(root).root) throw safeStorageFailure();
  try {
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    const information = await lstat(root);
    if (!information.isDirectory() || information.isSymbolicLink()) {
      throw safeStorageFailure();
    }
    await chmod(root, 0o700);
    return await realpath(root);
  } catch (error) {
    if (!create && nodeErrorCode(error) === "ENOENT") return null;
    if (error instanceof HttpProblem) throw error;
    throw safeStorageFailure();
  }
}

async function privateChildDirectory(
  canonicalRoot: string,
  parent: string,
  segment: string,
  create: boolean,
): Promise<string | null> {
  const candidate = containedPath(canonicalRoot, path.relative(canonicalRoot, parent), segment);
  try {
    if (create) {
      try {
        await mkdir(candidate, { mode: 0o700 });
      } catch (error) {
        if (nodeErrorCode(error) !== "EEXIST") throw error;
      }
    }
    const information = await lstat(candidate);
    if (!information.isDirectory() || information.isSymbolicLink()) {
      throw safeStorageFailure();
    }
    await chmod(candidate, 0o700);
    const canonical = await realpath(candidate);
    if (!isWithin(canonicalRoot, canonical) || canonical === canonicalRoot) {
      throw safeStorageFailure();
    }
    return canonical;
  } catch (error) {
    if (!create && nodeErrorCode(error) === "ENOENT") return null;
    if (error instanceof HttpProblem) throw error;
    throw safeStorageFailure();
  }
}

interface LocalQuarantineNamespace {
  root: string;
  assets: string;
}

async function assetNamespace(
  root: string,
  segments: StorageSegments,
  create: boolean,
): Promise<LocalQuarantineNamespace | null> {
  const canonicalRoot = await privateRoot(root, create);
  if (!canonicalRoot) return null;
  const tenants = await privateChildDirectory(canonicalRoot, canonicalRoot, "tenants", create);
  if (!tenants) return null;
  const organization = await privateChildDirectory(
    canonicalRoot,
    tenants,
    segments.organization,
    create,
  );
  if (!organization) return null;
  const assets = await privateChildDirectory(canonicalRoot, organization, "assets", create);
  return assets ? { root: canonicalRoot, assets } : null;
}

async function assetDirectory(
  root: string,
  segments: StorageSegments,
  create: boolean,
): Promise<{ root: string; assets: string; asset: string } | null> {
  const namespace = await assetNamespace(root, segments, create);
  if (!namespace) return null;
  const asset = await privateChildDirectory(
    namespace.root,
    namespace.assets,
    segments.asset,
    create,
  );
  return asset ? { ...namespace, asset } : null;
}

function storageRootBinding(
  canonicalRoot: string,
  information: Awaited<ReturnType<typeof lstat>>,
): string {
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw safeStorageFailure();
  }
  return [
    canonicalRoot,
    String(information.dev),
    String(information.ino),
    String(information.birthtimeMs),
  ].join("\0");
}

function storageAuthorityGeneration(rootBinding: string, seed: string): string {
  return createHash("sha256")
    .update(STORAGE_AUTHORITY_DOMAIN, "utf8")
    .update(rootBinding, "utf8")
    .update("\0", "utf8")
    .update(seed, "ascii")
    .digest("hex");
}

function storageAuthorityBytes(rootBinding: string, seed: string): Buffer {
  return Buffer.from([
    "paperpilot-local-quarantine-authority-v1",
    seed,
    storageAuthorityGeneration(rootBinding, seed),
    "",
  ].join("\n"), "utf8");
}

async function readBoundedRegularFile(file: string): Promise<Buffer> {
  let handle: FileHandle | null = null;
  try {
    const pathInformation = await lstat(file);
    if (!pathInformation.isFile() || pathInformation.isSymbolicLink()) {
      throw safeStorageFailure();
    }
    const flags = process.platform === "win32"
      ? fileConstants.O_RDONLY
      : fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW;
    handle = await open(file, flags);
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.size < 1
      || before.size > MAX_CONTROL_FILE_BYTES
      || before.dev !== pathInformation.dev
      || before.ino !== pathInformation.ino
    ) throw safeStorageFailure();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      !after.isFile()
      || after.size !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || bytes.byteLength !== before.size
    ) throw safeStorageFailure();
    return bytes;
  } catch (error) {
    if (error instanceof HttpProblem) throw error;
    throw safeStorageFailure();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseStorageAuthority(
  rootBinding: string,
  bytes: Buffer,
): LocalQuarantineStorageAuthority {
  const lines = bytes.toString("utf8").split("\n");
  if (
    lines.length !== 4
    || lines[0] !== "paperpilot-local-quarantine-authority-v1"
    || !STORAGE_AUTHORITY_PATTERN.test(lines[1] ?? "")
    || !STORAGE_AUTHORITY_PATTERN.test(lines[2] ?? "")
    || lines[3] !== ""
    || lines[2] !== storageAuthorityGeneration(rootBinding, lines[1])
  ) throw safeStorageFailure();
  return { schemaVersion: 1, generation: lines[2] };
}

async function readStorageAuthorityAtCanonicalRoot(
  canonicalRoot: string,
): Promise<LocalQuarantineStorageAuthority> {
  const rootBinding = storageRootBinding(canonicalRoot, await lstat(canonicalRoot));
  const markerPath = containedPath(canonicalRoot, STORAGE_AUTHORITY_FILE_NAME);
  return parseStorageAuthority(
    rootBinding,
    await readBoundedRegularFile(markerPath),
  );
}

/**
 * Resolve one immutable generation for the canonical local quarantine root.
 * The marker is atomically installed and its generation is bound to both a
 * random seed and the canonical root, so copying it to a different root fails.
 */
export async function localQuarantineStorageAuthority(
  configuration: Pick<UploadConfiguration, "quarantineRoot">,
): Promise<LocalQuarantineStorageAuthority> {
  return resolveLocalQuarantineStorageAuthority(configuration, true);
}

/** Read an existing root authority without provisioning an empty wrong root. */
export async function readLocalQuarantineStorageAuthority(
  configuration: Pick<UploadConfiguration, "quarantineRoot">,
): Promise<LocalQuarantineStorageAuthority> {
  return resolveLocalQuarantineStorageAuthority(configuration, false);
}

async function resolveLocalQuarantineStorageAuthority(
  configuration: Pick<UploadConfiguration, "quarantineRoot">,
  create: boolean,
): Promise<LocalQuarantineStorageAuthority> {
  if (
    typeof configuration.quarantineRoot !== "string"
    || !path.isAbsolute(configuration.quarantineRoot)
  ) throw new TypeError("A valid local quarantine root is required.");
  const canonicalRoot = await privateRoot(configuration.quarantineRoot, create);
  if (!canonicalRoot) throw storageAuthorityMismatch();
  const rootBinding = storageRootBinding(canonicalRoot, await lstat(canonicalRoot));
  const markerPath = containedPath(canonicalRoot, STORAGE_AUTHORITY_FILE_NAME);
  if (!create) {
    try {
      await lstat(markerPath);
      return readStorageAuthorityAtCanonicalRoot(canonicalRoot);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") throw storageAuthorityMismatch();
      throw error;
    }
  }
  const seed = createHash("sha256")
    .update(STORAGE_AUTHORITY_DOMAIN, "utf8")
    .update(randomUUID(), "ascii")
    .digest("hex");
  const pendingPath = containedPath(
    canonicalRoot,
    `${STORAGE_AUTHORITY_FILE_NAME}.${randomUUID()}.part`,
  );
  let pending: FileHandle | null = null;
  try {
    pending = await open(pendingPath, "wx", 0o600);
    await writeAll(pending, storageAuthorityBytes(rootBinding, seed));
    await pending.sync();
    await pending.close();
    pending = null;
    try {
      await link(pendingPath, markerPath);
      await chmod(markerPath, 0o400);
    } catch (error) {
      if (nodeErrorCode(error) !== "EEXIST") throw error;
    }
  } catch (error) {
    if (error instanceof HttpProblem) throw error;
    throw safeStorageFailure();
  } finally {
    await pending?.close().catch(() => undefined);
    await unlinkIfPresent(pendingPath).catch(() => undefined);
  }
  return parseStorageAuthority(rootBinding, await readBoundedRegularFile(markerPath));
}

function requireStorageAuthorityGeneration(value: string): string {
  if (!STORAGE_AUTHORITY_PATTERN.test(value)) {
    throw new TypeError("A canonical storage authority generation is required.");
  }
  return value;
}

function storageAuthorityMismatch(): HttpProblem {
  return new HttpProblem(
    409,
    "storage_authority_mismatch",
    "The quarantine root does not match the admitted storage authority.",
  );
}

function custodyAlreadyDeleted(): HttpProblem {
  return new HttpProblem(
    409,
    "quarantine_custody_deleted",
    "This quarantine target no longer accepts private bytes.",
  );
}

function custodyTombstoneName(segments: StorageSegments): string {
  return `.${segments.asset}.custody-deleted-v1`;
}

function custodyTombstonePath(
  namespace: LocalQuarantineNamespace,
  segments: StorageSegments,
): string {
  return containedPath(
    namespace.root,
    path.relative(namespace.root, namespace.assets),
    custodyTombstoneName(segments),
  );
}

async function requireNoCustodyTombstone(
  namespace: LocalQuarantineNamespace,
  segments: StorageSegments,
): Promise<void> {
  try {
    await lstat(custodyTombstonePath(namespace, segments));
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return;
    throw safeStorageFailure();
  }
  // Any object at the reserved marker path fences writers, even when damaged.
  throw custodyAlreadyDeleted();
}

function assertRuntimeConfiguration(
  configuration: LocalQuarantineStreamConfiguration,
): void {
  if (
    typeof configuration.quarantineRoot !== "string"
    || !path.isAbsolute(configuration.quarantineRoot)
    || !Number.isSafeInteger(configuration.maxUploadBytes)
    || configuration.maxUploadBytes <= 0
    || !Number.isSafeInteger(configuration.streamIdleTimeoutMs)
    || configuration.streamIdleTimeoutMs <= 0
    || !Number.isSafeInteger(configuration.streamAbsoluteTimeoutMs)
    || configuration.streamAbsoluteTimeoutMs <= 0
    || configuration.streamIdleTimeoutMs > configuration.streamAbsoluteTimeoutMs
  ) {
    throw new TypeError("A valid local quarantine configuration is required.");
  }
}

function assertCanonicalExpectedMd5(expectedMd5: string | undefined): void {
  if (expectedMd5 !== undefined && !/^[a-f0-9]{32}$/.test(expectedMd5)) {
    throw new TypeError("A canonical lowercase expected MD5 digest is required.");
  }
}

function assertExpectedSize(expected: bigint, maximum: number): void {
  if (typeof expected !== "bigint" || expected <= 0n) {
    throw new HttpProblem(
      400,
      "invalid_upload_size",
      "The upload session has an invalid expected byte count.",
    );
  }
  if (expected > BigInt(maximum)) {
    throw new HttpProblem(
      413,
      "upload_too_large",
      "The upload exceeds the configured byte limit.",
    );
  }
}

function requireIdentityEncoding(request: Request): void {
  const encoding = request.headers.get("content-encoding");
  if (encoding !== null && encoding.toLowerCase() !== "identity") {
    throw new HttpProblem(
      415,
      "unsupported_content_encoding",
      "Compressed upload request bodies are not accepted.",
    );
  }
  if (
    request.headers.has("content-length")
    && request.headers.has("transfer-encoding")
  ) {
    throw new HttpProblem(
      400,
      "invalid_content_length",
      "The upload request has ambiguous transport framing.",
    );
  }
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      null,
    );
    if (bytesWritten <= 0) throw safeStorageFailure();
    offset += bytesWritten;
  }
}

async function unlinkIfPresent(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
  }
}

function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: string,
): void {
  // Cancellation is advisory. A custom or platform stream may return a promise
  // that rejects or never settles, so file cleanup must never await it.
  void reader.cancel(reason).catch(() => undefined);
}

function uploadAborted(): HttpProblem {
  return new HttpProblem(400, "upload_aborted", "The upload was interrupted.");
}

function uploadTimedOut(): HttpProblem {
  return new HttpProblem(
    408,
    "upload_timed_out",
    "The upload stopped making progress before it completed.",
  );
}

async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  absoluteDeadline: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const remaining = Math.ceil(absoluteDeadline - performance.now());
  if (remaining <= 0) throw uploadTimedOut();
  const waitMs = Math.min(idleTimeoutMs, remaining);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(uploadTimedOut());
    }, waitMs);
    void reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Persist an already-authorized PDF byte stream into tenant-bound quarantine.
 * Source authentication and HTTP response validation belong to the caller;
 * this primitive owns bounded custody, content integrity, and finalization.
 */
export async function streamAuthorizedPdfToLocalQuarantine(
  input: LocalQuarantineStreamInput,
): Promise<LocalQuarantineUploadResult> {
  assertRuntimeConfiguration(input.configuration);
  assertExpectedSize(input.expectedSizeBytes, input.configuration.maxUploadBytes);
  assertCanonicalExpectedMd5(input.expectedMd5);
  const expectedStorageAuthorityGeneration = input.expectedStorageAuthorityGeneration === undefined
    ? null
    : requireStorageAuthorityGeneration(input.expectedStorageAuthorityGeneration);
  const authority = await localQuarantineStorageAuthority(input.configuration);
  if (
    expectedStorageAuthorityGeneration !== null
    && authority.generation !== expectedStorageAuthorityGeneration
  ) throw storageAuthorityMismatch();

  const segments = storageSegments(input.organizationId, input.assetId);
  const attemptSegment = storageSegment(
    "quarantine-attempt-v1",
    boundedOpaqueId(input.attemptId, "attemptId"),
  );
  const namespace = await assetNamespace(
    input.configuration.quarantineRoot,
    segments,
    true,
  );
  if (!namespace) throw safeStorageFailure();
  if (
    (await readStorageAuthorityAtCanonicalRoot(namespace.root)).generation
      !== authority.generation
  ) throw storageAuthorityMismatch();
  await requireNoCustodyTombstone(namespace, segments);
  const asset = await privateChildDirectory(
    namespace.root,
    namespace.assets,
    segments.asset,
    true,
  );
  if (!asset) throw safeStorageFailure();
  const directory = { ...namespace, asset };
  // A deleter may have installed the stable parent tombstone while this
  // process was creating the asset directory. Check again before any bytes.
  await requireNoCustodyTombstone(namespace, segments);

  const partName = `.${attemptSegment}.${randomUUID()}.part`;
  const partPath = containedPath(directory.root, path.relative(directory.root, directory.asset), partName);
  const finalPath = containedPath(
    directory.root,
    path.relative(directory.root, directory.asset),
    `${attemptSegment}.quarantine`,
  );
  const reader = input.body.getReader();
  const envelope = new IncrementalPdfEnvelopeValidator();
  const sha256Hash = createHash("sha256");
  const md5Hash = createHash("md5");
  const maximumBytes = BigInt(input.configuration.maxUploadBytes);
  const absoluteDeadline = performance.now()
    + input.configuration.streamAbsoluteTimeoutMs;
  let actualBytes = 0n;
  let handle: FileHandle | null = null;
  let linked = false;
  let aborted = input.signal?.aborted ?? false;

  const onAbort = () => {
    aborted = true;
    cancelReader(reader, "PaperPilot quarantine stream aborted");
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted && !aborted) onAbort();

  try {
    if (aborted) throw uploadAborted();
    await requireNoCustodyTombstone(namespace, segments);
    handle = await open(partPath, "wx", 0o600);

    while (true) {
      if (aborted) throw uploadAborted();
      const { done, value } = await readWithDeadline(
        reader,
        input.configuration.streamIdleTimeoutMs,
        absoluteDeadline,
      );
      if (done) break;
      if (!(value instanceof Uint8Array)) throw safeStorageFailure();
      if (value.byteLength === 0) continue;

      const nextBytes = actualBytes + BigInt(value.byteLength);
      if (nextBytes > maximumBytes) {
        cancelReader(reader, "PaperPilot upload byte limit exceeded");
        throw new HttpProblem(
          413,
          "upload_too_large",
          "The upload exceeds the configured byte limit.",
        );
      }
      if (nextBytes > input.expectedSizeBytes) {
        cancelReader(reader, "PaperPilot upload exceeded its declared size");
        throw new HttpProblem(
          400,
          "content_length_mismatch",
          "The upload body does not match the expected byte count.",
        );
      }

      await writeAll(handle, value);
      sha256Hash.update(value);
      md5Hash.update(value);
      envelope.push(value);
      actualBytes = nextBytes;
    }

    if (aborted) throw uploadAborted();
    if (actualBytes !== input.expectedSizeBytes) {
      throw new HttpProblem(
        400,
        "content_length_mismatch",
        "The upload body does not match the expected byte count.",
      );
    }
    const pdf = envelope.finish();
    if (performance.now() >= absoluteDeadline) throw uploadTimedOut();
    const sha256 = sha256Hash.digest("hex");
    const md5 = md5Hash.digest("hex");
    if (input.expectedMd5 !== undefined && md5 !== input.expectedMd5) {
      throw new HttpProblem(
        409,
        "content_md5_mismatch",
        "The streamed bytes do not match the expected content digest.",
      );
    }
    await handle.sync();
    await handle.close();
    handle = null;

    try {
      // This check plus the deleter's atomic asset-directory retirement closes
      // the check/link race: the link is either captured by the rename or its
      // source path has already moved and finalization fails.
      await requireNoCustodyTombstone(namespace, segments);
      await link(partPath, finalPath);
      linked = true;
    } catch (error) {
      if (nodeErrorCode(error) === "EEXIST") {
        throw new HttpProblem(
          409,
          "upload_already_stored",
          "This upload target already contains quarantined bytes.",
        );
      }
      throw error;
    }
    await chmod(finalPath, 0o400);
    await unlink(partPath);

    return {
      storageKey: storageKeyFor(segments, attemptSegment),
      sizeBytes: actualBytes,
      sha256,
      md5,
      mimeType: "application/pdf",
      pdfVersion: pdf.version,
      storageAuthorityGeneration: authority.generation,
    };
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The safe error below is authoritative; cleanup remains best effort.
      }
    }
    try {
      await unlinkIfPresent(partPath);
    } catch {
      // Do not replace the fixed, non-path-bearing failure with an unlink error.
    }
    cancelReader(reader, "PaperPilot quarantine write failed");
    if (linked) {
      try {
        await unlinkIfPresent(finalPath);
      } catch {
        // A later reconciler must handle the improbable compensation failure.
      }
    }
    if (error instanceof HttpProblem) throw error;
    throw safeStorageFailure();
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Browser-upload adapter. All request-specific media and framing checks happen
 * before the source-neutral custody primitive can create filesystem state.
 */
export async function streamRequestToLocalQuarantine(
  input: LocalQuarantineUploadInput,
): Promise<LocalQuarantineUploadResult> {
  assertRuntimeConfiguration(input.configuration);
  assertExpectedSize(input.expectedSizeBytes, input.configuration.maxUploadBytes);
  requireExactPdfContentType(input.request.headers.get("content-type"));
  requireIdentityEncoding(input.request);

  const contentLength = parseContentLengthHeader(
    input.request.headers.get("content-length"),
  );
  if (contentLength !== null && contentLength > BigInt(input.configuration.maxUploadBytes)) {
    throw new HttpProblem(
      413,
      "upload_too_large",
      "The upload exceeds the configured byte limit.",
    );
  }
  if (contentLength !== null && contentLength !== input.expectedSizeBytes) {
    throw new HttpProblem(
      400,
      "content_length_mismatch",
      "Content-Length does not match the upload session.",
    );
  }
  if (!input.request.body) {
    throw new HttpProblem(
      400,
      "content_length_mismatch",
      "The upload body does not match the expected byte count.",
    );
  }

  return streamAuthorizedPdfToLocalQuarantine({
    body: input.request.body,
    configuration: input.configuration,
    organizationId: input.organizationId,
    assetId: input.assetId,
    attemptId: input.attemptId,
    expectedSizeBytes: input.expectedSizeBytes,
    signal: input.request.signal,
  });
}

function objectMissing(): HttpProblem {
  return new HttpProblem(
    409,
    "quarantine_object_missing",
    "The quarantined object is unavailable.",
  );
}

function objectChanged(): HttpProblem {
  return new HttpProblem(
    409,
    "quarantine_object_changed",
    "The quarantined object changed during validation.",
  );
}

function sameFileIdentity(
  before: Awaited<ReturnType<FileHandle["stat"]>>,
  after: Awaited<ReturnType<FileHandle["stat"]>>,
): boolean {
  return before.isFile()
    && after.isFile()
    && before.size === after.size
    && before.dev === after.dev
    && before.ino === after.ino
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs
    && before.nlink === 1
    && after.nlink === 1;
}

/**
 * Open one identity-bound object and keep that exact handle alive for the
 * complete validation callback. No operating-system path leaves this module.
 */
export async function withOpenLocalQuarantineObject<T>(
  configuration: Pick<UploadConfiguration, "quarantineRoot">,
  storageKey: string,
  identity: LocalQuarantineObjectIdentity,
  operation: (object: OpenLocalQuarantineObject) => Promise<T>,
  expectedStorageAuthorityGeneration?: string | null,
): Promise<T> {
  if (
    typeof configuration.quarantineRoot !== "string"
    || !path.isAbsolute(configuration.quarantineRoot)
  ) {
    throw new TypeError("A valid local quarantine root is required.");
  }
  const decoded = decodeStorageKey(storageKey);
  requireStorageKeyIdentity(decoded, identity);
  if (expectedStorageAuthorityGeneration !== undefined && expectedStorageAuthorityGeneration !== null) {
    const expected = requireStorageAuthorityGeneration(expectedStorageAuthorityGeneration);
    const authority = await readLocalQuarantineStorageAuthority(configuration);
    if (authority.generation !== expected) throw storageAuthorityMismatch();
  }
  const directory = await assetDirectory(configuration.quarantineRoot, decoded, false);
  if (!directory) throw objectMissing();
  await requireNoCustodyTombstone(directory, decoded);
  const filePath = containedPath(
    directory.root,
    path.relative(directory.root, directory.asset),
    finalFileName(decoded),
  );
  let handle: FileHandle;
  try {
    const flags = process.platform === "win32"
      ? fileConstants.O_RDONLY
      : fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW;
    handle = await open(filePath, flags);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") throw objectMissing();
    throw safeStorageFailure();
  }
  try {
    const before = await handle.stat();
    await requireNoCustodyTombstone(directory, decoded);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1) {
      throw objectChanged();
    }
    const result = await operation({
      handle,
      sizeBytes: BigInt(before.size),
      storageKey,
    });
    const after = await handle.stat();
    if (!sameFileIdentity(before, after)) throw objectChanged();
    return result;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function custodyTombstoneBytes(
  generation: string,
  segments: StorageSegments,
  tombstoneId: string,
): Buffer {
  return Buffer.from([
    "paperpilot-local-quarantine-custody-tombstone-v1",
    generation,
    segments.organization,
    segments.asset,
    tombstoneId,
    "",
  ].join("\n"), "utf8");
}

function parseCustodyTombstone(
  bytes: Buffer,
  generation: string,
  segments: StorageSegments,
): LocalQuarantineCustodyDeletionProof {
  const lines = bytes.toString("utf8").split("\n");
  if (
    lines.length !== 6
    || lines[0] !== "paperpilot-local-quarantine-custody-tombstone-v1"
    || lines[1] !== generation
    || lines[2] !== segments.organization
    || lines[3] !== segments.asset
    || !CUSTODY_TOMBSTONE_ID_PATTERN.test(lines[4] ?? "")
    || lines[5] !== ""
  ) throw safeStorageFailure();
  return {
    schemaVersion: 1,
    storageAuthorityGeneration: generation,
    tombstoneDigest: createHash("sha256")
      .update(CUSTODY_TOMBSTONE_DOMAIN, "utf8")
      .update(bytes)
      .digest("hex"),
  };
}

async function establishCustodyTombstone(
  namespace: LocalQuarantineNamespace,
  segments: StorageSegments,
  generation: string,
): Promise<LocalQuarantineCustodyDeletionProof> {
  const markerPath = custodyTombstonePath(namespace, segments);
  const pendingPath = containedPath(
    namespace.root,
    path.relative(namespace.root, namespace.assets),
    `.${segments.asset}.custody-tombstone.${randomUUID()}.part`,
  );
  let pending: FileHandle | null = null;
  try {
    pending = await open(pendingPath, "wx", 0o600);
    await writeAll(
      pending,
      custodyTombstoneBytes(generation, segments, randomUUID()),
    );
    await pending.sync();
    await pending.close();
    pending = null;
    try {
      await link(pendingPath, markerPath);
      await chmod(markerPath, 0o400);
    } catch (error) {
      if (nodeErrorCode(error) !== "EEXIST") throw error;
    }
  } catch (error) {
    if (error instanceof HttpProblem) throw error;
    throw safeStorageFailure();
  } finally {
    await pending?.close().catch(() => undefined);
    await unlinkIfPresent(pendingPath).catch(() => undefined);
  }
  return parseCustodyTombstone(
    await readBoundedRegularFile(markerPath),
    generation,
    segments,
  );
}

const QUARANTINE_OBJECT_FILE_PATTERN = /^(?:original\.quarantine|[a-f0-9]{64}\.quarantine|\.[a-f0-9]{64}\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.part)$/;

function retiredAssetPrefix(segments: StorageSegments): string {
  return `.${segments.asset}.custody-retired.`;
}

async function retireLiveAssetNamespace(
  namespace: LocalQuarantineNamespace,
  segments: StorageSegments,
): Promise<void> {
  const livePath = containedPath(
    namespace.root,
    path.relative(namespace.root, namespace.assets),
    segments.asset,
  );
  let information;
  try {
    information = await lstat(livePath);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return;
    throw safeStorageFailure();
  }
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw safeStorageFailure();
  }
  const retiredPath = containedPath(
    namespace.root,
    path.relative(namespace.root, namespace.assets),
    `${retiredAssetPrefix(segments)}${randomUUID()}`,
  );
  try {
    await rename(livePath, retiredPath);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return;
    throw safeStorageFailure();
  }
}

async function removeRetiredAssetNamespaces(
  namespace: LocalQuarantineNamespace,
  segments: StorageSegments,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(namespace.assets, { withFileTypes: true });
  } catch {
    throw safeStorageFailure();
  }
  const retiredPattern = new RegExp(
    `^\\.${segments.asset}\\.custody-retired\\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
  );
  for (const entry of entries) {
    if (!retiredPattern.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw safeStorageFailure();
    const retiredPath = containedPath(
      namespace.root,
      path.relative(namespace.root, namespace.assets),
      entry.name,
    );
    let objects;
    try {
      objects = await readdir(retiredPath, { withFileTypes: true });
    } catch {
      throw safeStorageFailure();
    }
    for (const object of objects) {
      if (
        !object.isFile()
        || object.isSymbolicLink()
        || !QUARANTINE_OBJECT_FILE_PATTERN.test(object.name)
      ) throw safeStorageFailure();
      const objectPath = containedPath(
        namespace.root,
        path.relative(namespace.root, retiredPath),
        object.name,
      );
      try {
        const information = await lstat(objectPath);
        if (!information.isFile() || information.isSymbolicLink()) {
          throw safeStorageFailure();
        }
        await unlink(objectPath);
      } catch (error) {
        if (error instanceof HttpProblem) throw error;
        throw safeStorageFailure();
      }
    }
    try {
      if ((await readdir(retiredPath)).length !== 0) throw safeStorageFailure();
      await rmdir(retiredPath);
    } catch (error) {
      if (error instanceof HttpProblem) throw error;
      throw safeStorageFailure();
    }
  }
}

async function custodyObjectNamespacesRemain(
  namespace: LocalQuarantineNamespace,
  segments: StorageSegments,
): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(namespace.assets, { withFileTypes: true });
  } catch {
    throw safeStorageFailure();
  }
  const retiredPrefix = retiredAssetPrefix(segments);
  for (const entry of entries) {
    if (entry.name === segments.asset || entry.name.startsWith(retiredPrefix)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw safeStorageFailure();
      return true;
    }
  }
  return false;
}

/**
 * Permanently fence one asset namespace, atomically retire every in-flight
 * writer into a deletion-owned namespace, remove final and partial objects,
 * and rescan before returning a stable, root-bound absence proof.
 */
export async function deleteLocalQuarantineAssetCustody(
  configuration: Pick<UploadConfiguration, "quarantineRoot">,
  identity: LocalQuarantineObjectIdentity,
  expectedStorageAuthorityGeneration: string,
): Promise<LocalQuarantineCustodyDeletionProof> {
  const expected = requireStorageAuthorityGeneration(
    expectedStorageAuthorityGeneration,
  );
  const authority = await readLocalQuarantineStorageAuthority(configuration);
  if (authority.generation !== expected) throw storageAuthorityMismatch();
  const segments = storageSegments(identity.organizationId, identity.assetId);
  const namespace = await assetNamespace(
    configuration.quarantineRoot,
    segments,
    true,
  );
  if (!namespace) throw safeStorageFailure();
  if (
    (await readStorageAuthorityAtCanonicalRoot(namespace.root)).generation
      !== authority.generation
  ) throw storageAuthorityMismatch();
  const proof = await establishCustodyTombstone(
    namespace,
    segments,
    authority.generation,
  );

  for (let iteration = 0; iteration < MAX_CUSTODY_RETIRE_LOOPS; iteration += 1) {
    await retireLiveAssetNamespace(namespace, segments);
    await removeRetiredAssetNamespaces(namespace, segments);
    if (await custodyObjectNamespacesRemain(namespace, segments)) continue;
    const verified = parseCustodyTombstone(
      await readBoundedRegularFile(custodyTombstonePath(namespace, segments)),
      authority.generation,
      segments,
    );
    // A second namespace scan after re-reading the immutable tombstone is the
    // publication boundary for absence proof.
    if (await custodyObjectNamespacesRemain(namespace, segments)) continue;
    if (verified.tombstoneDigest !== proof.tombstoneDigest) {
      throw safeStorageFailure();
    }
    if (
      (await readStorageAuthorityAtCanonicalRoot(namespace.root)).generation
        !== authority.generation
    ) throw storageAuthorityMismatch();
    return proof;
  }
  throw safeStorageFailure();
}

/** Remove one crashed receive attempt's immutable final object and partials. */
export async function removeLocalQuarantineAttemptObjects(
  configuration: Pick<UploadConfiguration, "quarantineRoot">,
  identity: LocalQuarantineObjectIdentity,
  attemptId: string,
  expectedStorageAuthorityGeneration?: string,
): Promise<void> {
  if (expectedStorageAuthorityGeneration !== undefined) {
    const expected = requireStorageAuthorityGeneration(
      expectedStorageAuthorityGeneration,
    );
    const authority = await readLocalQuarantineStorageAuthority(configuration);
    if (authority.generation !== expected) throw storageAuthorityMismatch();
  }
  const storageKey = localQuarantineStorageKeyForAttempt(identity, attemptId);
  await removeLocalQuarantineObject(configuration, storageKey, identity);
  const decoded = decodeStorageKey(storageKey);
  const directory = await assetDirectory(configuration.quarantineRoot, decoded, false);
  if (!directory || decoded.version !== 2 || !decoded.attempt) return;
  const partPattern = new RegExp(
    `^\\.${decoded.attempt}\\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.part$`,
  );
  let entries;
  try {
    entries = await readdir(directory.asset, { withFileTypes: true });
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return;
    throw safeStorageFailure();
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !partPattern.test(entry.name)) continue;
    const candidate = containedPath(
      directory.root,
      path.relative(directory.root, directory.asset),
      entry.name,
    );
    try {
      const information = await lstat(candidate);
      if (!information.isFile() || information.isSymbolicLink()) throw safeStorageFailure();
      await unlink(candidate);
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") throw safeStorageFailure();
    }
  }
}

/** Delete exactly one generated quarantine object. No directories are removed. */
export async function removeLocalQuarantineObject(
  configuration: Pick<UploadConfiguration, "quarantineRoot">,
  storageKey: string,
  identity: LocalQuarantineObjectIdentity,
): Promise<void> {
  if (
    typeof configuration.quarantineRoot !== "string"
    || !path.isAbsolute(configuration.quarantineRoot)
  ) {
    throw new TypeError("A valid local quarantine root is required.");
  }
  const decoded = decodeStorageKey(storageKey);
  requireStorageKeyIdentity(decoded, identity);
  const directory = await assetDirectory(configuration.quarantineRoot, decoded, false);
  if (!directory) return;
  const finalPath = containedPath(
    directory.root,
    path.relative(directory.root, directory.asset),
    finalFileName(decoded),
  );
  try {
    const information = await lstat(finalPath);
    if (!information.isFile() || information.isSymbolicLink()) {
      throw safeStorageFailure();
    }
    await unlink(finalPath);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return;
    if (error instanceof HttpProblem) throw error;
    throw safeStorageFailure();
  }
}
