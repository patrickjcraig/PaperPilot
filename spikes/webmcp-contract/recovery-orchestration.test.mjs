import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { MultiDirectedGraph } from "graphology";
import { createSpikeState, createToolSuite, enqueueHumanWorkspaceAction } from "./contracts.mjs";
import { browserSnapshotKey, clearBrowserSnapshot, loadBrowserSnapshot, saveBrowserSnapshot } from "./browser-snapshot.mjs";

const source = await readFile(new URL("./app.mjs", import.meta.url), "utf8");
const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
const ast = ts.createSourceFile("app.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(ast.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name)
  .map((node) => [node.name.text, node.getText(ast)]));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise((resolve) => setImmediate(resolve));
let sequence = 0;
const fixture = (options = {}) => createSpikeState(MultiDirectedGraph, {
  id: (prefix) => `${prefix}:recovery:${++sequence}`, now: () => "2026-09-03T12:00:00.000Z", ...options,
});
function storageFixture() {
  const values = new Map();
  return {
    values, gets: [], sets: [], removes: [], setError: null, getError: null, removeError: null,
    getItem(key) { this.gets.push(key); if (this.getError) throw this.getError; return values.get(key) ?? null; },
    setItem(key, value) { if (this.setError) throw this.setError; this.sets.push(key); values.set(key, value); },
    removeItem(key) { if (this.removeError) throw this.removeError; this.removes.push(key); values.delete(key); },
  };
}
function fingerprint(state) {
  return structuredClone({ paper: state.paper, graph: state.graph.export(), anchors: [...state.anchors], annotations: [...state.annotations],
    history: state.history, redoHistory: state.redoHistory, revisions: state.revisions, events: state.events,
    requestResults: [...state.requestResults], explanations: state.explanations, savedExplanations: state.savedExplanations,
    workspaceRevision: state.workspaceRevision, workspaceDigest: state.workspaceDigest, graphDigest: state.graphDigest,
    annotationDigest: state.annotationDigest, focusAnchorId: state.focusAnchorId,
  });
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function actualSave(input) {
  // Production runs in one realm. The AST harness's view-only objects cross a
  // VM boundary, so bridge those objects without weakening the real serializer.
  return saveBrowserSnapshot({ ...input, savedExplanations: structuredClone(input.savedExplanations), presentation: structuredClone(input.presentation) });
}
async function harness({ storage = storageFixture(), save = actualSave, load = loadBrowserSnapshot, state } = {}) {
  state ||= await fixture();
  const events = [], timers = [];
  const document = { body: {}, activeElement: null };
  document.activeElement = document.body;
  const elements = new Proxy({}, { get(target, key) {
    return target[key] ||= {
      textContent: "", attributes: new Map(), isConnected: true, _disabled: false, _hidden: false,
      get disabled() { return this._disabled; },
      set disabled(value) { this._disabled = value; if (value && document.activeElement === this) document.activeElement = document.body; },
      get hidden() { return this._hidden; },
      set hidden(value) { this._hidden = value; if (value && document.activeElement === this) document.activeElement = document.body; },
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      focus(options) { if (!this.disabled && !this.hidden) { this.focusOptions = options; document.activeElement = this; } },
      classList: { flags: new Map(), toggle(name, enabled) { this.flags.set(name, enabled); } },
    };
  } });
  const context = vm.createContext({
    state, savedExplanations: [], annotationOrder: Object.freeze([...state.annotations.keys()]),
    snapshotEnabled: false, snapshotDirty: false, snapshotStored: false, snapshotHasSavedCopies: false, snapshotStatusKind: "idle", snapshotStatusMessage: "Not saved · active tab only",
    snapshotSaveQueue: Promise.resolve(), snapshotGeneration: 0, snapshotEditGeneration: 0, snapshotReady: true,
    snapshotPendingSaves: 0, snapshotClearPending: false, clearSavedCopyArmed: null, paperSessionGeneration: 0, pageLeaving: false,
    elements, document, structuredClone, enqueueHumanWorkspaceAction, saveBrowserSnapshot: save, loadBrowserSnapshot: load, clearBrowserSnapshot,
    browserStorageAdapter: () => storage,
    recordActivity(type, details) { events.push({ type, ...details }); },
    recordHumanEvidenceEvent(type, details) { events.push({ type, ...details }); },
    mergeRestoredActivity() {}, setTimeout(callback) { timers.push(callback); return timers.length; },
  });
  for (const name of ["renderBrowserSaveState", "resetBrowserWorkspacePersistence", "captureBrowserSnapshotSession", "isCurrentBrowserSnapshotSession", "snapshotPresentation", "markSnapshotDirty", "snapshotFailureMessage", "persistBrowserWorkspace", "restoreBrowserWorkspace", "saveBrowserWorkspaceFromControl", "clearSavedBrowserWorkspaceFromControl", "cancelClearSavedBrowserWorkspaceFromControl"]) {
    assert.ok(functions.has(name), `Production ${name} exists`);
    vm.runInContext(functions.get(name), context, { filename: `app.mjs:${name}` });
  }
  return { context, events, timers, elements, storage, state, document };
}

async function graphEdit(state) {
  const tool = createToolSuite(state).find(({ name }) => name === "paperpilot.apply_graph");
  const result = await tool.execute({
    idempotencyKey: `recovery-edit-${++sequence}`, baseWorkspaceRevision: state.workspaceRevision,
    baseWorkspaceDigest: state.workspaceDigest, baseGraphDigest: state.graphDigest,
    reason: "A newer semantic edit during a browser recovery test.", operations: [{ op: "add_node", clientRef: "client:recovery",
      node: { kind: "concept", label: "New reader context", summary: "Grounded test context", authority: "paper_grounded", sourceAnchorIds: ["anchor:text:attention"], salience: 0.5 },
    }],
  });
  assert.equal(result.status, "applied_reversible", JSON.stringify(result));
  return result;
}

test("snapshot pre-write cancellation preserves the exact previous copy and live collections", async (t) => {
  for (const cause of ["guard", "paper", "paper_digest_in_place", "revision", "focus", "graph", "throwing_guard"]) await t.test(cause, async () => {
    const state = await fixture();
    const storage = storageFixture();
    assert.equal((await saveBrowserSnapshot({ storage, state })).status, "saved");
    const key = browserSnapshotKey(state.paper.documentSha256);
    const oldBytes = storage.values.get(key);
    let current = true;
    const pending = saveBrowserSnapshot({ storage, state, isCurrent: () => { if (cause === "throwing_guard" && !current) throw new Error("obsolete"); return current; } });
    if (cause === "guard" || cause === "throwing_guard") current = false;
    if (cause === "paper") state.paper = { ...state.paper, documentSha256: "d".repeat(64) };
    if (cause === "paper_digest_in_place") state.paper.documentSha256 = "d".repeat(64);
    if (cause === "revision") state.workspaceRevision += 1;
    if (cause === "focus") state.focusAnchorId = "anchor:page:1";
    if (cause === "graph") state.graph = state.graph.copy();
    const before = fingerprint(state);
    assert.equal((await pending).status, "cancelled");
    assert.deepEqual(fingerprint(state), before);
    assert.equal(storage.values.get(key), oldBytes);
    assert.equal(storage.sets.length, 1);
  });
});

test("snapshot decode checks cancellation before hydration, including changed identity and newer live state", async (t) => {
  const sourceState = await fixture();
  await graphEdit(sourceState);
  const storage = storageFixture();
  assert.equal((await saveBrowserSnapshot({ storage, state: sourceState })).status, "saved");
  for (const cause of ["guard", "paper", "paper_digest_in_place", "revision", "focus", "annotations"]) await t.test(cause, async () => {
    const target = await fixture();
    let current = true;
    const pending = loadBrowserSnapshot({ storage, state: target, isCurrent: () => current });
    if (cause === "guard") current = false;
    if (cause === "paper") target.paper = { ...target.paper, documentSha256: "e".repeat(64) };
    if (cause === "paper_digest_in_place") target.paper.documentSha256 = "e".repeat(64);
    if (cause === "revision") target.workspaceRevision += 1;
    if (cause === "focus") target.focusAnchorId = "anchor:page:1";
    if (cause === "annotations") target.annotations = new Map(target.annotations);
    const before = fingerprint(target);
    assert.equal((await pending).status, "cancelled");
    assert.deepEqual(fingerprint(target), before);
  });
  assert.equal(storage.sets.length, 1);
  assert.equal(storage.removes.length, 0);
});

test("cancelling an in-progress v2 migration preserves old bytes without hydration or a new v3 copy", async () => {
  const sourceState = await fixture();
  const storage = storageFixture();
  assert.equal((await saveBrowserSnapshot({ storage, state: sourceState })).status, "saved");
  const key = browserSnapshotKey(sourceState.paper.documentSha256);
  const envelope = JSON.parse(storage.values.get(key));
  envelope.schemaVersion = 2;
  envelope.payload.schemaVersion = 2;
  delete envelope.payload.workspace.revisions;
  envelope.payloadChecksum = createHash("sha256").update(canonical(envelope.payload)).digest("hex");
  const legacyKey = `paperpilot:webmcp:v2:${sourceState.paper.documentSha256}`;
  const originalBytes = JSON.stringify(envelope);
  storage.values.delete(key);
  storage.values.set(legacyKey, originalBytes);
  const target = await fixture();
  const before = fingerprint(target);
  let active = true;
  const pending = loadBrowserSnapshot({ storage, state: target, isCurrent: () => active });
  active = false;
  assert.equal((await pending).status, "cancelled");
  assert.deepEqual(fingerprint(target), before);
  assert.equal(storage.values.get(legacyKey), originalBytes);
  assert.equal(storage.values.has(key), false);
  assert.equal(storage.removes.length, 0);
  assert.equal(storage.sets.length, 1);
});

test("actual save and clear buttons delegate to the tested production handlers", () => {
  assert.match(source, /elements\.saveWorkspace\.addEventListener\("click", \(\) => void saveBrowserWorkspaceFromControl\(\)\)/u);
  assert.match(source, /elements\.clearSavedWorkspace\.addEventListener\("click", \(\) => void clearSavedBrowserWorkspaceFromControl\(\)\)/u);
  assert.match(source, /elements\.cancelClearSavedWorkspace\.addEventListener\("click", cancelClearSavedBrowserWorkspaceFromControl\)/u);
  assert.match(functions.get("boot"), /const paperSession = \+\+paperSessionGeneration;\s*resetBrowserWorkspacePersistence\(\)/u);
});

test("clear confirmation cancels in-flight and queued autosaves before removing only the exact paper key", async () => {
  const gate = deferred();
  const h = await harness();
  assert.equal((await h.context.saveBrowserWorkspaceFromControl()).status, "saved");
  const key = browserSnapshotKey(h.state.paper.documentSha256);
  const legacyKeys = [1, 2].map((version) => `paperpilot:webmcp:v${version}:${h.state.paper.documentSha256}`);
  for (const legacyKey of legacyKeys) h.storage.values.set(legacyKey, "older saved version");
  h.storage.values.set("paperpilot:webmcp:v3:unrelated", "untouched");
  h.context.saveBrowserSnapshot = async (input) => { await gate.promise; return actualSave(input); };
  h.context.markSnapshotDirty();
  const inFlight = h.context.snapshotSaveQueue;
  await flush();
  h.context.markSnapshotDirty();
  const queued = h.context.snapshotSaveQueue;
  assert.equal((await h.context.clearSavedBrowserWorkspaceFromControl()).status, "confirmation_required");
  const clearing = h.context.clearSavedBrowserWorkspaceFromControl();
  assert.equal(h.context.snapshotEnabled, false);
  assert.equal(h.elements.saveWorkspace.disabled, false);
  assert.equal(h.elements.saveWorkspace.getAttribute("aria-disabled"), "true");
  gate.resolve();
  assert.equal((await inFlight).status, "cancelled");
  assert.equal((await queued).status, "cancelled");
  assert.equal((await clearing).status, "cleared");
  assert.equal(h.storage.values.has(key), false);
  assert.ok(legacyKeys.every((legacyKey) => !h.storage.values.has(legacyKey)));
  assert.equal(h.storage.values.get("paperpilot:webmcp:v3:unrelated"), "untouched");
  assert.deepEqual(h.storage.removes, [...legacyKeys, key]);
  assert.equal(h.storage.sets.length, 1, "stale autosaves must not recreate the cleared copy");
  assert.equal(h.context.snapshotStored, false);
  assert.equal(h.context.snapshotDirty, true);
  assert.match(h.elements.browserSaveStatus.textContent, /not saved in this browser/iu);
  h.context.markSnapshotDirty();
  await h.context.snapshotSaveQueue;
  assert.equal(h.storage.sets.length, 1, "clear disables future autosave until another explicit Save");
  assert.equal((await loadBrowserSnapshot({ storage: h.storage, state: await fixture() })).status, "not_found", "older formats cannot resurrect after confirmed clear");
});

test("a pending save cannot write or announce success for a newly loaded paper", async () => {
  const gate = deferred();
  const h = await harness({ save: async (input) => { await gate.promise; return actualSave(input); } });
  const oldKey = browserSnapshotKey(h.state.paper.documentSha256);
  const saving = h.context.saveBrowserWorkspaceFromControl();
  await flush();
  h.context.paperSessionGeneration += 1;
  h.context.resetBrowserWorkspacePersistence();
  const other = await fixture({ paper: { paperRef: "paper:other", filename: h.state.paper.filename, documentSha256: "d".repeat(64), pageCount: 1 } });
  h.context.state = other;
  assert.equal((await h.context.restoreBrowserWorkspace()).status, "not_found");
  const message = h.elements.browserSaveStatus.textContent;
  gate.resolve();
  assert.equal((await saving).status, "cancelled");
  assert.equal(h.storage.values.has(oldKey), false);
  assert.equal(h.storage.values.has(browserSnapshotKey(other.paper.documentSha256)), false);
  assert.equal(h.elements.browserSaveStatus.textContent, message);
  assert.equal(h.context.snapshotEnabled, false);
  assert.equal(h.events.some(({ type }) => type === "browser_workspace_saved"), false);
  assert.equal(h.elements.saveWorkspace.disabled, false);
});

test("late restore cannot hydrate either the old session or its replacement", async () => {
  const gate = deferred();
  const stored = await fixture();
  await graphEdit(stored);
  const storage = storageFixture();
  assert.equal((await saveBrowserSnapshot({ storage, state: stored })).status, "saved");
  const h = await harness({ storage, load: async (input) => { await gate.promise; return loadBrowserSnapshot(input); } });
  const oldBefore = fingerprint(h.state);
  const loading = h.context.restoreBrowserWorkspace();
  await flush();
  h.context.paperSessionGeneration += 1;
  h.context.resetBrowserWorkspacePersistence();
  h.context.state = await fixture({ paper: { paperRef: "paper:other", filename: h.state.paper.filename, documentSha256: "d".repeat(64), pageCount: 1 } });
  const newBefore = fingerprint(h.context.state);
  gate.resolve();
  assert.equal((await loading).status, "cancelled");
  assert.deepEqual(fingerprint(h.state), oldBefore);
  assert.deepEqual(fingerprint(h.context.state), newBefore);
  assert.equal(h.context.snapshotReady, false);
  assert.equal(h.events.some(({ type }) => type === "browser_workspace_restored"), false);
});

test("clear confirmation is document-bound and never carries authorization into the next paper", async () => {
  const h = await harness();
  assert.equal((await h.context.saveBrowserWorkspaceFromControl()).status, "saved");
  assert.equal((await h.context.clearSavedBrowserWorkspaceFromControl()).status, "confirmation_required");
  const oldKey = browserSnapshotKey(h.state.paper.documentSha256);
  h.context.paperSessionGeneration += 1;
  h.context.resetBrowserWorkspacePersistence();
  h.context.state = await fixture({ paper: { paperRef: "paper:other", filename: h.state.paper.filename, documentSha256: "d".repeat(64), pageCount: 1 } });
  await h.context.restoreBrowserWorkspace();
  assert.equal((await h.context.saveBrowserWorkspaceFromControl()).status, "saved");
  const newKey = browserSnapshotKey(h.context.state.paper.documentSha256);
  assert.equal((await h.context.clearSavedBrowserWorkspaceFromControl()).status, "confirmation_required", "The old paper's confirmation cannot clear the new paper");
  assert.equal(h.timers.length, 0, "Confirmation does not expire while its warning is being read.");
  assert.equal(h.elements.clearSavedWorkspace.textContent, "Confirm clear");
  assert.equal((await h.context.clearSavedBrowserWorkspaceFromControl()).status, "cleared");
  assert.equal(h.storage.values.has(oldKey), true);
  assert.equal(h.storage.values.has(newKey), false);
  assert.deepEqual(h.storage.removes, [newKey]);
});

test("paper replacement cancels an already-confirmed clear that has not reached its exact-key deletion", async () => {
  const gate = deferred();
  const h = await harness();
  await h.context.saveBrowserWorkspaceFromControl();
  const oldKey = browserSnapshotKey(h.state.paper.documentSha256);
  const originalBytes = h.storage.values.get(oldKey);
  h.context.saveBrowserSnapshot = async (input) => { await gate.promise; return actualSave(input); };
  h.context.markSnapshotDirty();
  await flush();
  await h.context.clearSavedBrowserWorkspaceFromControl();
  const clearing = h.context.clearSavedBrowserWorkspaceFromControl();
  h.context.paperSessionGeneration += 1;
  h.context.resetBrowserWorkspacePersistence();
  h.context.state = await fixture({ paper: { paperRef: "paper:other", filename: h.state.paper.filename, documentSha256: "d".repeat(64), pageCount: 1 } });
  await h.context.restoreBrowserWorkspace();
  const status = h.elements.browserSaveStatus.textContent;
  gate.resolve();
  assert.equal((await clearing).status, "cancelled");
  assert.equal(h.storage.values.get(oldKey), originalBytes);
  assert.equal(h.storage.removes.length, 0);
  assert.equal(h.elements.browserSaveStatus.textContent, status);
  assert.equal(h.events.some(({ type }) => type === "browser_workspace_cleared"), false);
});

test("persistent confirmation has an explicit Cancel which restores focus and requires confirmation again", async () => {
  const h = await harness();
  await h.context.saveBrowserWorkspaceFromControl();
  const priorMessage = h.elements.browserSaveStatus.textContent;
  await h.context.clearSavedBrowserWorkspaceFromControl();
  assert.equal(h.timers.length, 0);
  assert.equal(h.elements.cancelClearSavedWorkspace.hidden, false);
  h.elements.cancelClearSavedWorkspace.focus();
  assert.equal(h.context.cancelClearSavedBrowserWorkspaceFromControl().status, "confirmation_cancelled");
  assert.equal(h.context.clearSavedCopyArmed, null);
  assert.equal(h.elements.browserSaveStatus.textContent, `Clear cancelled. ${priorMessage}`);
  assert.equal(h.elements.cancelClearSavedWorkspace.hidden, true);
  assert.equal(h.elements.browserClearWarning.hidden, true);
  assert.equal(h.document.activeElement, h.elements.clearSavedWorkspace);
  assert.equal((await h.context.clearSavedBrowserWorkspaceFromControl()).status, "confirmation_required");
  assert.equal(h.storage.removes.length, 0);
});

test("Save stays keyboard-focusable while pending, blocks repeated activation, and disarms a prior Clear intent", async () => {
  const h = await harness(); await h.context.saveBrowserWorkspaceFromControl();
  await h.context.clearSavedBrowserWorkspaceFromControl();
  const gate = deferred();
  h.context.saveBrowserSnapshot = async (input) => { await gate.promise; return actualSave(input); };
  h.elements.saveWorkspace.focus();
  const saving = h.context.saveBrowserWorkspaceFromControl();
  assert.equal(h.context.clearSavedCopyArmed, null);
  assert.equal(h.elements.browserClearWarning.hidden, true);
  assert.equal(h.elements.cancelClearSavedWorkspace.hidden, true);
  assert.equal(h.elements.saveWorkspace.disabled, false);
  assert.equal(h.elements.saveWorkspace.getAttribute("aria-disabled"), "true");
  assert.equal(h.elements.saveWorkspace.getAttribute("aria-busy"), "true");
  assert.equal(h.document.activeElement, h.elements.saveWorkspace);
  assert.equal((await h.context.saveBrowserWorkspaceFromControl()).status, "cancelled");
  gate.resolve(); assert.equal((await saving).status, "saved");
  assert.equal(h.elements.saveWorkspace.getAttribute("aria-disabled"), "false");
  assert.equal(h.elements.saveWorkspace.getAttribute("aria-busy"), "false");
  assert.equal(h.document.activeElement, h.elements.saveWorkspace);
  assert.equal(h.storage.sets.length, 2);
  assert.equal(h.storage.removes.length, 0);
});

test("background save success or failure cannot remove the armed Clear warning or its Cancel action", async (t) => {
  for (const outcome of ["saved", "storage_error"]) await t.test(outcome, async () => {
    const h = await harness(); await h.context.saveBrowserWorkspaceFromControl();
    await h.context.clearSavedBrowserWorkspaceFromControl();
    const warning = h.elements.browserClearWarning.textContent;
    const gate = deferred();
    h.context.saveBrowserSnapshot = async (input) => { await gate.promise; return outcome === "saved" ? actualSave(input) : { status: "storage_error" }; };
    h.context.markSnapshotDirty(); const saving = h.context.snapshotSaveQueue;
    h.elements.cancelClearSavedWorkspace.focus();
    gate.resolve(); await saving;
    assert.equal(h.elements.browserClearWarning.textContent, warning);
    assert.equal(h.elements.browserClearWarning.hidden, false);
    assert.equal(h.elements.cancelClearSavedWorkspace.hidden, false);
    assert.equal(h.elements.clearSavedWorkspace.textContent, "Confirm clear");
    assert.equal(h.document.activeElement, h.elements.cancelClearSavedWorkspace);
    assert.equal(h.elements.browserSaveStatus.getAttribute("role"), outcome === "saved" ? "status" : "alert");
    const latestStatus = h.elements.browserSaveStatus.textContent;
    h.context.cancelClearSavedBrowserWorkspaceFromControl();
    assert.equal(h.elements.browserSaveStatus.textContent, `Clear cancelled. ${latestStatus}`, "Cancel retains the latest save result, not a stale pre-confirmation success.");
    assert.equal(h.storage.removes.length, 0);
  });
});

test("confirmed Clear preserves its pending focus and returns to Save only if the reader has not moved elsewhere", async (t) => {
  for (const moveAway of [false, true]) await t.test(moveAway ? "reader moved elsewhere" : "reader stayed on Clear", async () => {
    const h = await harness(); await h.context.saveBrowserWorkspaceFromControl();
    const gate = deferred();
    h.context.saveBrowserSnapshot = async (input) => { await gate.promise; return actualSave(input); };
    h.context.markSnapshotDirty(); await flush();
    h.elements.clearSavedWorkspace.focus();
    await h.context.clearSavedBrowserWorkspaceFromControl();
    const clearing = h.context.clearSavedBrowserWorkspaceFromControl();
    assert.equal(h.elements.clearSavedWorkspace.disabled, false);
    assert.equal(h.elements.clearSavedWorkspace.getAttribute("aria-disabled"), "true");
    assert.equal(h.elements.clearSavedWorkspace.getAttribute("aria-busy"), "true");
    assert.equal(h.document.activeElement, h.elements.clearSavedWorkspace);
    assert.equal((await h.context.clearSavedBrowserWorkspaceFromControl()).status, "cancelled");
    assert.equal((await h.context.saveBrowserWorkspaceFromControl()).status, "cancelled");
    if (moveAway) h.elements.unrelatedReaderControl.focus();
    gate.resolve(); assert.equal((await clearing).status, "cleared");
    assert.equal(h.elements.clearSavedWorkspace.disabled, true);
    assert.equal(h.elements.clearSavedWorkspace.getAttribute("aria-busy"), "false");
    assert.equal(h.document.activeElement, moveAway ? h.elements.unrelatedReaderControl : h.elements.saveWorkspace);
    if (!moveAway) assert.equal(h.elements.saveWorkspace.focusOptions.preventScroll, true);
  });
});

test("recovery controls reference their status and persistent confirmation, without a timed reading requirement", () => {
  for (const [id, description] of [["save-workspace", "browser-save-status"], ["clear-saved-workspace", "browser-save-status browser-clear-warning"],
    ["cancel-clear-saved-workspace", "browser-clear-warning"]]) {
    const tag = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`, "u"))?.[0] || "";
    assert.match(tag, new RegExp(`aria-describedby="${description}"`, "u"));
  }
  assert.match(html, /id="browser-clear-warning"[^>]*role="status"[^>]*aria-atomic="true"/u);
  assert.doesNotMatch(functions.get("clearSavedBrowserWorkspaceFromControl"), /setTimeout/u);
});

test("quota, unavailable storage, invalid snapshots, and unexpected save failures keep live state explicitly unsaved", async (t) => {
  for (const mode of ["quota", "unavailable", "invalid", "throw"]) await t.test(mode, async () => {
    const h = await harness();
    await h.context.saveBrowserWorkspaceFromControl();
    const key = browserSnapshotKey(h.state.paper.documentSha256);
    const old = h.storage.values.get(key);
    await graphEdit(h.state);
    h.context.markSnapshotDirty({ saveIfEnabled: false });
    const before = fingerprint(h.state);
    if (mode === "quota") h.storage.setError = Object.assign(new Error("full"), { name: "QuotaExceededError" });
    if (mode === "unavailable") h.context.browserStorageAdapter = () => null;
    if (mode === "invalid") h.context.saveBrowserSnapshot = async () => ({ status: "invalid_state", reason: "history_invalid" });
    if (mode === "throw") h.context.saveBrowserSnapshot = async () => { throw new Error("unexpected serialization failure"); };
    const eventCount = h.events.filter(({ type }) => type === "browser_workspace_saved").length;
    const result = await h.context.saveBrowserWorkspaceFromControl();
    assert.notEqual(result.status, "saved");
    assert.deepEqual(fingerprint(h.state), before);
    assert.equal(h.storage.values.get(key), old);
    assert.equal(h.context.snapshotDirty, true);
    assert.equal(h.context.snapshotStored, true, "the older saved copy remains available");
    assert.equal(h.context.snapshotStatusKind, "error");
    assert.match(h.elements.browserSaveStatus.textContent, /Not saved in this browser/u);
    assert.equal(h.events.filter(({ type }) => type === "browser_workspace_saved").length, eventCount);
    assert.equal(h.elements.saveWorkspace.disabled, false);
  });
});

test("clear failure preserves the existing copy and cannot be followed by a stale autosave", async () => {
  const h = await harness();
  await h.context.saveBrowserWorkspaceFromControl();
  const key = browserSnapshotKey(h.state.paper.documentSha256);
  const old = h.storage.values.get(key);
  h.storage.removeError = new Error("denied");
  await h.context.clearSavedBrowserWorkspaceFromControl();
  assert.equal((await h.context.clearSavedBrowserWorkspaceFromControl()).status, "storage_error");
  assert.equal(h.storage.values.get(key), old);
  assert.equal(h.context.snapshotEnabled, false);
  assert.equal(h.context.snapshotStored, true);
  assert.equal(h.context.snapshotDirty, true);
  assert.equal(h.context.snapshotClearPending, false);
  assert.equal(h.events.some(({ type }) => type === "browser_workspace_cleared"), false);
  assert.match(h.elements.browserSaveStatus.textContent, /could not be cleared.*automatic saving is off/iu);
});

test("explicit clear reads only the exact known same-PDF versions, then deletes legacy copies before current v3", async () => {
  const state = await fixture();
  const storage = storageFixture();
  const keys = [1, 2, 3].map((version) => `paperpilot:webmcp:v${version}:${state.paper.documentSha256}`);
  for (const key of keys) storage.values.set(key, `Bytes for ${key}`);
  const untouched = new Map([
    [browserSnapshotKey("a".repeat(64)), "another paper"],
    [`paperpilot:webmcp:v4:${state.paper.documentSha256}`, "unknown future format"],
    ["unrelated-setting", "not PaperPilot"],
  ]);
  for (const [key, value] of untouched) storage.values.set(key, value);
  const originalRemove = storage.removeItem;
  storage.removeItem = function remove(key) {
    assert.deepEqual(this.gets, keys, "all targets must be read before the first deletion");
    originalRemove.call(this, key);
  };
  const result = clearBrowserSnapshot({ storage, documentSha256: state.paper.documentSha256 });
  assert.equal(result.status, "cleared");
  assert.deepEqual(result.removedVersions, [1, 2, 3]);
  assert.deepEqual(result.remainingVersions, []);
  assert.deepEqual(storage.removes, keys);
  assert.deepEqual(storage.values, untouched);
  const gets = storage.gets.length;
  assert.throws(() => clearBrowserSnapshot({ storage, documentSha256: "not-a-pdf-digest" }));
  assert.equal(storage.gets.length, gets);
});

test("failed pre-clear reads remove nothing; partial removal reports exact versions and preserves current v3", async (t) => {
  const state = await fixture();
  for (const phase of ["read", "remove-v1", "remove-v2", "remove-v3"]) await t.test(phase, () => {
    const storage = storageFixture();
    const keys = [1, 2, 3].map((version) => `paperpilot:webmcp:v${version}:${state.paper.documentSha256}`);
    for (const key of keys) storage.values.set(key, `Original ${key}`);
    const originalGet = storage.getItem;
    const originalRemove = storage.removeItem;
    storage.getItem = function get(key) { if (phase === "read" && key === keys[1]) throw new Error("read denied"); return originalGet.call(this, key); };
    storage.removeItem = function remove(key) { if (phase === `remove-v${keys.indexOf(key) + 1}`) throw new Error("remove denied"); originalRemove.call(this, key); };
    const result = clearBrowserSnapshot({ storage, documentSha256: state.paper.documentSha256 });
    const removed = phase === "remove-v2" ? [1] : phase === "remove-v3" ? [1, 2] : [];
    assert.deepEqual(result.removedVersions, removed);
    assert.equal(result.status, removed.length ? "partial_clear" : "storage_error");
    assert.deepEqual(result.remainingVersions, phase === "read" ? null : [1, 2, 3].filter((version) => !removed.includes(version)));
    assert.equal(storage.values.get(keys[2]), `Original ${keys[2]}`, "v3 survives every partial failure");
    assert.deepEqual(storage.removes, removed.map((version) => keys[version - 1]));
  });
});

test("legacy-only recovery exposes explicit all-version Clear without pretending a v3 copy exists", async () => {
  const h = await harness();
  const key = `paperpilot:webmcp:v1:${h.state.paper.documentSha256}`;
  h.storage.values.set(key, "preserved legacy-only note");
  h.context.resetBrowserWorkspacePersistence();
  assert.equal((await h.context.restoreBrowserWorkspace()).status, "legacy_preserved");
  assert.equal(h.context.snapshotStored, false);
  assert.equal(h.context.snapshotHasSavedCopies, true);
  assert.equal(h.elements.saveWorkspace.textContent, "Save in this browser");
  assert.equal(h.elements.clearSavedWorkspace.disabled, false);
  const before = fingerprint(h.state);
  assert.equal((await h.context.clearSavedBrowserWorkspaceFromControl()).status, "confirmation_required");
  assert.match(h.elements.browserClearWarning.textContent, /Clear all saved versions of this paper.*cannot be recovered/iu);
  assert.equal(h.storage.values.has(key), true);
  assert.equal((await h.context.clearSavedBrowserWorkspaceFromControl()).status, "cleared");
  assert.deepEqual(fingerprint(h.state), before);
  assert.equal(h.storage.values.has(key), false);
  assert.equal(h.context.snapshotHasSavedCopies, false);
  assert.equal(h.elements.clearSavedWorkspace.disabled, true);
});

test("the actual Clear handler truthfully reports partial legacy removal and retains retry access", async () => {
  const h = await harness();
  await h.context.saveBrowserWorkspaceFromControl();
  const keys = [1, 2, 3].map((version) => `paperpilot:webmcp:v${version}:${h.state.paper.documentSha256}`);
  h.storage.values.set(keys[0], "legacy v1");
  h.storage.values.set(keys[1], "legacy v2");
  const currentBytes = h.storage.values.get(keys[2]);
  const originalRemove = h.storage.removeItem;
  h.storage.removeItem = function remove(key) { if (key === keys[1]) throw new Error("legacy removal denied"); originalRemove.call(this, key); };
  await h.context.clearSavedBrowserWorkspaceFromControl();
  const result = await h.context.clearSavedBrowserWorkspaceFromControl();
  assert.equal(result.status, "partial_clear");
  assert.equal(h.storage.values.has(keys[0]), false);
  assert.equal(h.storage.values.get(keys[1]), "legacy v2");
  assert.equal(h.storage.values.get(keys[2]), currentBytes);
  assert.equal(h.context.snapshotStored, true);
  assert.equal(h.context.snapshotHasSavedCopies, true);
  assert.equal(h.context.snapshotEnabled, false);
  assert.equal(h.elements.clearSavedWorkspace.disabled, false);
  assert.match(h.elements.browserSaveStatus.textContent, /cleared \(v1\).*v2, v3.*remain saved/iu);
  assert.equal(h.events.some(({ type }) => type === "browser_workspace_cleared"), false);
});

test("presentation edits during serialization cancel the old save and the queued latest save remains honest", async () => {
  const gate = deferred();
  let calls = 0;
  const h = await harness({ save: async (input) => { if (++calls === 1) await gate.promise; return actualSave(input); } });
  const pending = h.context.saveBrowserWorkspaceFromControl();
  await flush();
  h.context.annotationOrder = Object.freeze([...h.state.annotations.keys()].reverse());
  h.context.markSnapshotDirty();
  gate.resolve();
  assert.equal((await pending).status, "cancelled");
  assert.equal((await h.context.snapshotSaveQueue).status, "saved");
  assert.equal(h.storage.sets.length, 1);
  const payload = JSON.parse(h.storage.values.get(browserSnapshotKey(h.state.paper.documentSha256))).payload;
  assert.deepEqual(payload.presentation.annotationOrder, [...h.context.annotationOrder]);
  assert.equal(h.context.snapshotDirty, false);
  assert.equal(h.context.snapshotPendingSaves, 0);
});

test("a successful earlier write cannot mark changes made before its completion announcement as saved", async () => {
  let h;
  h = await harness({ save: async (input) => {
    const result = await actualSave(input);
    h.context.markSnapshotDirty({ saveIfEnabled: false });
    return result;
  } });
  const result = await h.context.saveBrowserWorkspaceFromControl();
  assert.equal(result.status, "saved_older");
  assert.equal(h.context.snapshotStored, true);
  assert.equal(h.context.snapshotDirty, true);
  assert.match(h.elements.browserSaveStatus.textContent, /Newer changes are not saved/u);
});

test("save waits for a pending semantic transaction rather than persisting its uncommitted projection", async () => {
  const gate = deferred();
  const h = await harness();
  const original = fingerprint(h.state);
  h.state.onStateChange = async () => { await gate.promise; throw new Error("projection rejected"); };
  const tool = createToolSuite(h.state).find(({ name }) => name === "paperpilot.apply_graph");
  const mutation = tool.execute({ idempotencyKey: "recovery-rollback", baseWorkspaceRevision: h.state.workspaceRevision,
    baseWorkspaceDigest: h.state.workspaceDigest, baseGraphDigest: h.state.graphDigest,
    reason: "Exercise failed mandatory projection before save", operations: [{ op: "add_node", clientRef: "client:pending",
      node: { kind: "concept", label: "Never committed", summary: "Failed projection", authority: "mentor_background", sourceAnchorIds: [], salience: 0.4 },
    }],
  });
  await flush();
  const pending = h.context.saveBrowserWorkspaceFromControl();
  await flush();
  assert.equal(h.storage.sets.length, 0);
  gate.resolve();
  assert.equal((await mutation).status, "rolled_back");
  assert.equal((await pending).status, "saved");
  const payload = JSON.parse(h.storage.values.get(browserSnapshotKey(h.state.paper.documentSha256))).payload;
  assert.equal(payload.workspace.current.workspaceDigest, original.workspaceDigest);
  assert.deepEqual(payload.workspace.current.graph, original.graph);
  assert.deepEqual(payload.workspace.revisions, []);
});

test("restore uses exact-byte identity, distinguishes read failure from corrupt content, and never falls back from corrupt v3", async () => {
  const h = await harness();
  await h.context.saveBrowserWorkspaceFromControl();
  const key = browserSnapshotKey(h.state.paper.documentSha256);
  const original = h.storage.values.get(key);
  h.storage.values.set(`paperpilot:webmcp:v2:${h.state.paper.documentSha256}`, "preserved legacy bytes");
  h.storage.values.set(key, "corrupt current bytes");
  h.context.resetBrowserWorkspacePersistence();
  const result = await h.context.restoreBrowserWorkspace();
  assert.equal(result.status, "invalid");
  assert.equal(h.context.snapshotEnabled, false);
  assert.equal(h.context.snapshotStored, true);
  assert.equal(h.storage.values.get(key), "corrupt current bytes");
  assert.equal(h.storage.gets.at(-1), key);
  h.storage.values.set(key, original);
  h.storage.getError = new Error("storage read denied");
  h.context.resetBrowserWorkspacePersistence();
  assert.equal((await h.context.restoreBrowserWorkspace()).status, "storage_error");
  assert.equal(h.context.snapshotStored, false, "read failure is not evidence that a saved copy was found");
  assert.match(h.elements.browserSaveStatus.textContent, /could not be read/iu);
  assert.doesNotMatch(h.elements.browserSaveStatus.textContent, /failed validation/iu);
});

test("page exit cancels every delayed save/restore without a late event", async () => {
  const gate = deferred();
  const h = await harness({ save: async (input) => { await gate.promise; return actualSave(input); } });
  const pending = h.context.saveBrowserWorkspaceFromControl();
  await flush();
  h.context.pageLeaving = true;
  gate.resolve();
  assert.equal((await pending).status, "cancelled");
  assert.equal(h.storage.sets.length, 0);
  assert.equal(h.events.length, 0);
  assert.equal((await h.context.restoreBrowserWorkspace()).status, "cancelled");
});
