import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("./app.mjs", import.meta.url), "utf8");
const parsed = ts.createSourceFile("app.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(parsed.statements.filter((item) => ts.isFunctionDeclaration(item) && item.name)
  .map((item) => [item.name.text, item.getText(parsed)]));

class ElementStub {
  editable = false;
  closest() { return this.editable ? this : null; }
}

test("production keyboard handler maps human Undo/Redo and leaves editor shortcuts alone", () => {
  const calls = [];
  let waiting = false;
  const elements = { humanUndo: { disabled: false }, humanRedo: { disabled: false } };
  const context = vm.createContext({ Element: ElementStub, elements,
    document: { body: { classList: { contains: () => waiting } } },
    performHumanHistoryAction: (action) => calls.push(action),
  });
  vm.runInContext(functions.get("handleHistoryShortcut"), context);
  const fire = (overrides = {}) => {
    let prevented = false;
    context.handleHistoryShortcut({ key: "z", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
      target: new ElementStub(), preventDefault: () => { prevented = true; }, ...overrides });
    return prevented;
  };
  assert.equal(fire(), true);
  assert.equal(fire({ ctrlKey: false, metaKey: true }), true);
  assert.equal(fire({ shiftKey: true }), true);
  assert.equal(fire({ key: "y" }), true);
  assert.deepEqual(calls, ["undo", "undo", "redo", "redo"]);
  const editor = new ElementStub(); editor.editable = true;
  for (const overrides of [{ target: editor }, { isComposing: true }, { defaultPrevented: true }, { altKey: true },
    { key: "x" }, { ctrlKey: false }, { key: "y", ctrlKey: false, metaKey: true }]) assert.equal(fire(overrides), false);
  waiting = true;
  assert.equal(fire(), false);
  waiting = false;
  elements.humanUndo.disabled = true;
  assert.equal(fire(), true);
  assert.equal(calls.length, 4);
});

test("production history action catches a rejected inverse and never saves a failed command", async () => {
  const activities = [];
  let saves = 0;
  const context = vm.createContext({ humanHistoryBusy: false, state: {},
    elements: { workspaceChangeStatus: { textContent: "" } },
    undoLastHumanChange: async () => { throw Object.assign(new Error("The workspace was preserved."), { code: "workspace_patch_conflict" }); },
    redoLastHumanChange: async () => ({ status: "redone", digestMatches: true }),
    recordActivity: (name, detail) => activities.push([name, detail]),
    renderLastResult: () => {}, renderState: () => {}, markSnapshotDirty: () => { saves += 1; },
  });
  vm.runInContext(functions.get("performHumanHistoryAction"), context);
  await context.performHumanHistoryAction("undo");
  assert.match(context.elements.workspaceChangeStatus.textContent, /Cannot undo.*preserved/u);
  assert.equal(activities[0][1].status, "workspace_patch_conflict");
  assert.equal(saves, 0);
  assert.equal(context.humanHistoryBusy, false);
  await context.performHumanHistoryAction("redo");
  assert.equal(saves, 1);
});

test("production history action serializes double activation without duplicate inverses", async () => {
  let resolve;
  const pending = new Promise((yes) => { resolve = yes; });
  let count = 0;
  const context = vm.createContext({ humanHistoryBusy: false, state: {},
    elements: { workspaceChangeStatus: { textContent: "" } },
    undoLastHumanChange: async () => { count += 1; return pending; },
    recordActivity: () => {}, renderLastResult: () => {}, renderState: () => {}, markSnapshotDirty: () => {},
  });
  vm.runInContext(functions.get("performHumanHistoryAction"), context);
  const first = context.performHumanHistoryAction("undo");
  await context.performHumanHistoryAction("undo");
  assert.equal(count, 1);
  resolve({ status: "undone" });
  await first;
  assert.equal(context.humanHistoryBusy, false);
});

test("review changes uses text-only DOM output and human controls have named shortcut help", async () => {
  const history = functions.get("renderWorkspaceHistory");
  assert.doesNotMatch(history, /innerHTML|outerHTML|insertAdjacentHTML/u);
  assert.match(history, /forwardPatch/u);
  assert.match(history, /inversePatch/u);
  assert.match(history, /Unreviewed/u);
  const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html, /id="workspace-change-status"[^>]*role="status"/u);
  assert.match(html, /id="human-undo"[^>]*aria-describedby="workspace-change-status"/u);
  assert.match(html, /id="human-redo"[^>]*aria-keyshortcuts=/u);
});
