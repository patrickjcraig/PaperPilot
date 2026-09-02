import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { PdfIntakeError, readBoundedPdfResponse, safeDemoFailure } from "./pdf-intake.mjs";

const source = await readFile(new URL("./app.mjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("app.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(ast.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name)
  .map((node) => [node.name.text, node.getText(ast)]));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const bytes = new Uint8Array([37, 80, 68, 70]);
  const calls = [], events = [], results = [];
  const elements = new Proxy({}, { get(target, key) {
    return target[key] ||= { textContent: "", hidden: false, disabled: false, value: "", files: [], attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
  } });
  const context = vm.createContext({
    elements, state: { paper: { paperRef: "paper:test" } }, pageLeaving: false,
    paperIntakeGeneration: 0, paperLoadController: new AbortController(), demoLoadController: null,
    document: { body: { classList: { add() {}, remove() {} } } },
    paperViewer: { documentFacts: { integrityVerified: true }, destroy() { calls.push({ kind: "destroy" }); } },
    ATTENTION_PDF: { byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    ATTENTION_DEMO_URL: "https://arxiv.org/pdf/1706.03762v7", ATTENTION_DEMO_FILENAME: "Attention Is All You Need.pdf",
    PDF_RELEASE_LIMITS: { maxBytes: 25 * 1024 * 1024 },
    AbortController, Uint8Array, Array, File, crypto: webcrypto,
    setTimeout, clearTimeout, PdfIntakeError, readBoundedPdfResponse, safeDemoFailure,
    safePdfError() { return { code: "PDF_VIEWER_FAILED", message: "The selected PDF could not be rendered." }; },
    async fetch(url, options) { calls.push({ kind: "fetch", url, options }); return new Response(bytes, { headers: { "content-type": "application/pdf" } }); },
    async boot({ pdfFile }) { calls.push({ kind: "boot", file: pdfFile }); },
    recordActivity(type, details) { events.push({ type, ...details }); },
    renderLastResult(result) { results.push(result); },
  });
  for (const name of ["reportInitializationFailure", "setPaperIntakeStatus", "beginWithPaper", "loadAttentionDemo", "openSelectedPaper"]) {
    vm.runInContext(functions.get(name), context, { filename: `app.mjs:${name}` });
  }
  return { context, elements, calls, events, results, bytes };
}

test("actual demo handler requests only pinned Attention without credentials or redirects and checks its fingerprint", async () => {
  const h = harness();
  await h.context.loadAttentionDemo();
  const fetch = h.calls.find(({ kind }) => kind === "fetch");
  assert.equal(fetch.url, "https://arxiv.org/pdf/1706.03762v7");
  assert.equal(fetch.options.credentials, "omit"); assert.equal(fetch.options.redirect, "error");
  assert.ok(fetch.options.signal instanceof AbortSignal);
  const opened = h.calls.find(({ kind }) => kind === "boot").file;
  assert.equal(opened.name, "Attention Is All You Need.pdf");
  assert.deepEqual(new Uint8Array(await opened.arrayBuffer()), h.bytes);
  assert.equal(h.elements.paperSourceGate.hidden, true);
  assert.equal(h.elements.workspaceSkipLinks.hidden, false);
  assert.equal(h.context.demoLoadController, null);
  assert.match(source, /const ATTENTION_DEMO_URL = ATTENTION_PDF\.sourceUrl/u);
});

test("a substituted same-sized demo cannot become the displayed paper", async () => {
  const h = harness(); h.context.ATTENTION_PDF.sha256 = "f".repeat(64);
  await h.context.loadAttentionDemo();
  assert.equal(h.calls.some(({ kind }) => kind === "boot"), false);
  assert.match(h.elements.paperSourceGateStatus.textContent, /does not match the recorded Attention v7/);
  assert.equal(h.elements.paperSourceGateStatus.attrs.role, "alert");
  assert.equal(h.elements.paperFileInput.disabled, false);
});

test("network errors do not disclose private messages and duplicate demo clicks do not duplicate downloads", async () => {
  const h = harness(), gate = deferred(); let fetches = 0;
  h.context.fetch = async () => { fetches += 1; return gate.promise; };
  const first = h.context.loadAttentionDemo();
  await h.context.loadAttentionDemo(); assert.equal(fetches, 1);
  gate.reject(new Error("private implementation URL https://private.example/token"));
  await first;
  assert.doesNotMatch(h.elements.paperSourceGateStatus.textContent, /private|token/u);
  assert.equal(h.elements.loadAttentionDemo.disabled, false);
  assert.equal(h.context.demoLoadController, null);
});

test("timeout during hashing restores intake controls and never opens the document", async () => {
  const h = harness(), gate = deferred();
  h.context.crypto = { subtle: { digest: () => gate.promise } };
  const pending = h.context.loadAttentionDemo(); await flush();
  h.context.demoLoadController.abort("private reason");
  gate.resolve(await webcrypto.subtle.digest("SHA-256", h.bytes)); await pending;
  assert.match(h.elements.paperSourceGateStatus.textContent, /cancelled or timed out/);
  assert.equal(h.calls.some(({ kind }) => kind === "boot"), false);
  assert.equal(h.elements.paperFileInput.disabled, false);
});

test("a departed page never opens a late download or publishes a false error", async () => {
  const h = harness(), gate = deferred(); h.context.fetch = () => gate.promise;
  const pending = h.context.loadAttentionDemo();
  h.context.pageLeaving = true; h.context.demoLoadController.abort();
  const before = h.elements.paperSourceGateStatus.textContent;
  gate.resolve(new Response(h.bytes, { headers: { "content-type": "application/pdf" } }));
  await pending;
  assert.equal(h.calls.some(({ kind }) => kind === "boot"), false);
  assert.equal(h.elements.paperSourceGateStatus.textContent, before);
});

test("a queued local-file intent cancels an older demo; late success or failure cannot replace it", async () => {
  for (const outcome of ["success", "failure"]) {
    const h = harness(), gate = deferred(); h.context.fetch = () => gate.promise;
    const pending = h.context.loadAttentionDemo();
    const oldController = h.context.demoLoadController;
    h.elements.paperFileInput.files = [{ name: "newer-local.pdf", size: 4 }];
    h.context.openSelectedPaper(); await flush();
    assert.equal(oldController.signal.aborted, true);
    assert.equal(h.context.demoLoadController, null);
    if (outcome === "success") gate.resolve(new Response(h.bytes, { headers: { "content-type": "application/pdf" } }));
    else gate.reject(new Error("old download failure"));
    await pending;
    assert.deepEqual(h.calls.filter(({ kind }) => kind === "boot").map(({ file }) => file.name), ["newer-local.pdf"]);
    assert.equal(h.elements.paperSourceGateStatus.textContent, "newer-local.pdf is active in this tab.");
    assert.equal(h.elements.paperSourceGate.hidden, true);
  }
});

test("a rejected local-file intent still cancels the old download and leaves usable intake", async () => {
  const h = harness(), gate = deferred(); h.context.fetch = () => gate.promise;
  const pending = h.context.loadAttentionDemo();
  h.elements.paperFileInput.files = [{ name: "empty.pdf", size: 0 }];
  h.context.openSelectedPaper();
  gate.resolve(new Response(h.bytes, { headers: { "content-type": "application/pdf" } }));
  await pending;
  assert.equal(h.calls.some(({ kind }) => kind === "boot"), false);
  assert.match(h.elements.paperSourceGateStatus.textContent, /empty/);
  assert.equal(h.elements.loadAttentionDemo.disabled, false);
  assert.equal(h.elements.paperFileInput.disabled, false);
});

test("empty or oversized local PDFs reject before boot with an associated actionable error", () => {
  for (const size of [0, 25 * 1024 * 1024 + 1]) {
    const h = harness(); h.elements.paperFileInput.files = [{ name: "paper.pdf", size }];
    h.context.openSelectedPaper();
    assert.equal(h.calls.some(({ kind }) => kind === "boot"), false);
    assert.equal(h.elements.paperSourceGateStatus.attrs.role, "alert");
    assert.match(h.elements.paperSourceGateStatus.textContent, /empty|25 MiB/);
    assert.equal(h.elements.paperFileInput.value, "");
  }
});

test("initialization failure keeps intake usable and never exposes parser detail in status or activity", async () => {
  const h = harness(); h.context.boot = async () => { throw new Error("private PDF parser internals"); };
  await h.context.beginWithPaper({ name: "paper.pdf" });
  assert.equal(h.elements.workspace.inert, true);
  assert.equal(h.elements.workspaceSkipLinks.hidden, true);
  assert.equal(h.elements.paperSourceGate.hidden, false);
  assert.equal(h.elements.loadAttentionDemo.disabled, false);
  assert.equal(h.context.paperLoadController.signal.aborted, true);
  assert.doesNotMatch(JSON.stringify([h.elements.paperSourceGateStatus.textContent, h.events, h.results]), /private|internals/u);
});

test("an older failed intake cannot destroy or hide a newer successful workspace", async () => {
  const h = harness(), old = deferred();
  h.context.boot = ({ pdfFile }) => pdfFile.name === "old.pdf" ? old.promise : Promise.resolve();
  const first = h.context.beginWithPaper({ name: "old.pdf" });
  await h.context.beginWithPaper({ name: "new.pdf" });
  old.reject(new Error("old parser failure")); await first;
  assert.equal(h.calls.some(({ kind }) => kind === "destroy"), false);
  assert.equal(h.elements.workspace.inert, false);
  assert.equal(h.elements.workspaceSkipLinks.hidden, false);
  assert.equal(h.elements.paperSourceGate.hidden, true);
  assert.match(h.elements.paperSourceGateStatus.textContent, /new\.pdf is active/);
  assert.equal(h.events.length, 0);
});

test("a boot with no initialized graph/PDF cannot falsely hide the intake as a success", async () => {
  const h = harness(); h.context.state = null; h.context.paperViewer = null;
  await h.context.beginWithPaper({ name: "paper.pdf" });
  assert.equal(h.elements.paperSourceGate.hidden, false);
  assert.equal(h.elements.workspace.inert, true);
  assert.match(h.elements.webmcpStatus.textContent, /Not registered/);
});

test("repeated initialization wires stable human controls once so one Clear click cannot confirm itself", () => {
  const h = harness(), listeners = [];
  const targets = new Proxy({}, { get(target, key) {
    if (["graphRailTabs", "graphNudgeButtons"].includes(key)) return target[key] ||= [];
    return target[key] ||= { textContent: "", addEventListener(type, callback) { listeners.push({ key, type, callback }); } };
  } });
  h.context.elements = targets; h.context.humanControlsWired = false;
  h.context.document.querySelectorAll = () => [];
  h.context.document.addEventListener = (type, callback) => listeners.push({ key: "document", type, callback });
  h.context.window = { addEventListener(type, callback) { listeners.push({ key: "window", type, callback }); } };
  for (const name of ["cancelClearSavedBrowserWorkspaceFromControl", "goToMentorExplanation", "cancelReaderSelection", "submitReaderAnnotation",
    "resetGraphLayout", "moveAnnotationPointerDrag", "cancelAnnotationPointerDrag", "recordVisualTrialAssessment"]) h.context[name] = () => {};
  let clearActions = 0;
  h.context.clearSavedBrowserWorkspaceFromControl = () => { clearActions += 1; };
  vm.runInContext(functions.get("wireHumanControls"), h.context);
  h.context.wireHumanControls(); const initialCount = listeners.length;
  h.context.wireHumanControls(); h.context.wireHumanControls();
  assert.equal(listeners.length, initialCount);
  const clear = listeners.filter(({ key, type }) => key === "clearSavedWorkspace" && type === "click");
  assert.equal(clear.length, 1);
  clear[0].callback(); assert.equal(clearActions, 1);
});
