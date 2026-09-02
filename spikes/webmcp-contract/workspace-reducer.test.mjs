import assert from "node:assert/strict";
import test from "node:test";
import { MultiDirectedGraph } from "graphology";

import {
  applyReaderAnnotation, createSpikeState, createToolSuite, mintReaderAnchor,
  removeReaderAnnotation, redoLastHumanChange, undoLastHumanChange,
} from "./contracts.mjs";

const ANCHOR = "anchor:text:attention";
const IDEA = "node:concept:attention";
const EDGE = "edge:introduction:attention";

async function fixture() {
  let sequence = 0;
  return createSpikeState(MultiDirectedGraph, {
    now: () => "2026-09-01T18:00:00.000Z",
    id: (prefix) => `${prefix}:${String(++sequence).padStart(8, "0")}`,
  });
}

function tool(state, name) {
  return createToolSuite(state).find((candidate) => candidate.name === `paperpilot.${name}`);
}

function addNode(clientRef = "client:new") {
  return {
    op: "add_node", clientRef,
    node: { kind: "concept", label: clientRef, summary: "A bounded source-grounded concept.", authority: "paper_grounded", sourceAnchorIds: [ANCHOR], salience: 0.7 },
  };
}

function addEdge(clientRef, source, target) {
  return { op: "add_edge", clientRef, edge: { source, target, kind: "supports", claim: "A grounded relationship.", authority: "paper_grounded", sourceAnchorIds: [ANCHOR] } };
}

function graphCommand(state, operations = [addNode()], key = "patch-graph-command-0001") {
  return { idempotencyKey: key, baseWorkspaceRevision: state.workspaceRevision, baseWorkspaceDigest: state.workspaceDigest,
    baseGraphDigest: state.graphDigest, reason: "Exercise the trusted reversible workspace reducer.", operations };
}

function annotationCommand(state, key = "patch-annotation-command-0001", operations) {
  return { idempotencyKey: key, baseWorkspaceRevision: state.workspaceRevision, baseWorkspaceDigest: state.workspaceDigest,
    baseAnnotationDigest: state.annotationDigest, reason: "Link a source through the shared workspace reducer.", operations: operations || [{
      op: "create_annotation", anchorId: ANCHOR, expectedAnchorDigest: state.anchors.get(ANCHOR).anchorDigest,
      annotationKind: "concept", label: "A grounded annotation", graphNodeKeys: [IDEA], graphEdgeKeys: [EDGE],
    }] };
}

function boundary(state, { events = true } = {}) {
  return JSON.stringify({
    graph: state.graph.export(), anchors: [...state.anchors], annotations: [...state.annotations],
    workspaceRevision: state.workspaceRevision, workspaceDigest: state.workspaceDigest,
    graphDigest: state.graphDigest, annotationDigest: state.annotationDigest,
    history: state.history, redoHistory: state.redoHistory, revisions: state.revisions,
    requestResults: [...state.requestResults], ...(events ? { events: state.events } : {}),
  });
}

function semanticDigests(state) {
  return [state.workspaceDigest, state.graphDigest, state.annotationDigest];
}

function assertCanonicalRevision(entry, { kind, paperRef } = {}) {
  assert.equal(entry.schemaVersion, 1);
  if (kind) assert.equal(entry.kind, kind);
  if (paperRef) assert.equal(entry.paperRef, paperRef);
  assert.equal(Object.hasOwn(entry, "before"), false, "History must not retain a before workspace snapshot.");
  assert.equal(Object.hasOwn(entry, "after"), false, "History must not retain an after workspace snapshot.");
  assert.match(entry.revisionId, /^[a-z][a-z0-9:_-]+$/u);
  for (const field of ["beforeWorkspaceDigest", "afterWorkspaceDigest", "beforeGraphDigest", "afterGraphDigest", "beforeAnnotationDigest", "afterAnnotationDigest"]) {
    assert.match(entry[field], /^[0-9a-f]{64}$/u, field);
  }
  assert.ok(Array.isArray(entry.forwardPatch));
  assert.ok(Array.isArray(entry.inversePatch));
  assert.equal(entry.forwardPatch.length, entry.inversePatch.length);
  const inverse = new Map(entry.inversePatch.map((operation) => [`${operation.op}:${operation.key}`, operation]));
  const keys = new Set();
  for (const operation of entry.forwardPatch) {
    assert.ok(["put_node", "put_edge", "put_annotation", "put_anchor"].includes(operation.op));
    const identity = `${operation.op}:${operation.key}`;
    assert.equal(keys.has(identity), false, "An entity has one normalized put per patch.");
    keys.add(identity);
    assert.ok(Object.hasOwn(operation, "before") && Object.hasOwn(operation, "after"));
    assert.deepEqual(inverse.get(identity)?.before, operation.after);
    assert.deepEqual(inverse.get(identity)?.after, operation.before);
    if (operation.op === "put_node" || operation.op === "put_edge") {
      for (const record of [operation.before, operation.after].filter(Boolean)) {
        for (const property of ["x", "y", "size", "color", "selected", "highlighted", "hidden", "hovered", "camera"]) {
          assert.equal(Object.hasOwn(record, property), false, `Canonical patch cannot contain ${property}.`);
        }
      }
    }
  }
}

async function applied(state, name, command) {
  const result = await tool(state, name).execute(command);
  assert.equal(result.status, "applied_reversible", JSON.stringify(result));
  return result;
}

test("trusted graph patches replace snapshots and append human Undo/Redo revisions without erasing the original", async () => {
  const state = await fixture();
  assert.ok(Array.isArray(state.revisions));
  const originalLedgerLength = state.revisions.length;
  const before = semanticDigests(state);
  const result = await applied(state, "apply_graph", graphCommand(state, [
    addNode("client:first"), addNode("client:second"),
    addEdge("client:edge:first", { refType: "client_ref", clientRef: "client:first" }, { refType: "client_ref", clientRef: "client:second" }),
    addEdge("client:edge:parallel", { refType: "client_ref", clientRef: "client:first" }, { refType: "client_ref", clientRef: "client:second" }),
  ]));
  const after = semanticDigests(state);
  const revision = structuredClone(state.revisions.at(-1));
  assertCanonicalRevision(revision, { kind: "graph", paperRef: state.paper.paperRef });
  assert.equal(revision.revisionId, result.revisionId);
  assert.equal(revision.forwardPatch.filter(({ op }) => op === "put_node").length, 2);
  assert.equal(revision.forwardPatch.filter(({ op }) => op === "put_edge").length, 2);
  assert.equal(state.history.at(-1).revisionId, revision.revisionId);
  const undo = await undoLastHumanChange(state);
  assert.equal(undo.status, "undone");
  assert.deepEqual(semanticDigests(state), before);
  assert.equal(state.revisions.length, originalLedgerLength + 2);
  assertCanonicalRevision(state.revisions.at(-1), { kind: "undo" });
  assert.equal(state.revisions.at(-1).relatedRevisionId, revision.revisionId);
  assert.deepEqual(state.revisions[originalLedgerLength], revision);
  assert.equal(state.history.length, 0);
  assert.equal(state.redoHistory.length, 1);
  const redo = await redoLastHumanChange(state);
  assert.equal(redo.status, "redone");
  assert.deepEqual(semanticDigests(state), after);
  assertCanonicalRevision(state.revisions.at(-1), { kind: "redo" });
  assert.equal(state.revisions.at(-1).relatedRevisionId, revision.revisionId);
  assert.equal(state.revisions.length, originalLedgerLength + 3);
  assert.equal(new Set(state.revisions.map(({ revisionId }) => revisionId)).size, state.revisions.length);
});

test("node and edge updates retain exact prior fields and metadata in the trusted inverse", async () => {
  const state = await fixture();
  const beforeNode = structuredClone(state.graph.getNodeAttributes(IDEA));
  const beforeEdge = structuredClone(state.graph.getEdgeAttributes(EDGE));
  const before = semanticDigests(state);
  await applied(state, "apply_graph", graphCommand(state, [{
    op: "update_node", nodeKey: IDEA, expectedEntityRevision: beforeNode.entityRevision,
    set: { label: "Changed label", summary: "Changed summary", salience: 0.13, authority: "mentor_background", sourceAnchorIds: [] },
  }, {
    op: "update_edge", edgeKey: EDGE, expectedEntityRevision: beforeEdge.entityRevision,
    set: { kind: "depends_on", claim: "Mentor context, not a paper claim.", authority: "mentor_background", sourceAnchorIds: [] },
  }]));
  const after = semanticDigests(state);
  assertCanonicalRevision(state.history.at(-1));
  await undoLastHumanChange(state);
  assert.deepEqual(state.graph.getNodeAttributes(IDEA), beforeNode);
  assert.deepEqual(state.graph.getEdgeAttributes(EDGE), beforeEdge);
  assert.deepEqual(semanticDigests(state), before);
  await redoLastHumanChange(state);
  assert.deepEqual(semanticDigests(state), after);
});

test("node tombstone includes all incident edges and its inverse preserves already tombstoned edges", async () => {
  const state = await fixture();
  const created = await applied(state, "apply_graph", graphCommand(state, [
    addEdge("client:parallel", { refType: "issued_key", key: "node:section:introduction" }, { refType: "issued_key", key: IDEA }),
    addEdge("client:outgoing", { refType: "issued_key", key: IDEA }, { refType: "issued_key", key: "node:paper" }),
  ]));
  const [alreadyGone] = created.affected.created;
  await applied(state, "apply_graph", graphCommand(state, [{ op: "tombstone_edge", edgeKey: alreadyGone,
    expectedEntityRevision: state.graph.getEdgeAttribute(alreadyGone, "entityRevision") }], "patch-tombstone-edge-0001"));
  const edgesBefore = new Map(state.graph.edges(IDEA).map((key) => [key, structuredClone(state.graph.getEdgeAttributes(key))]));
  const before = semanticDigests(state);
  await applied(state, "apply_graph", graphCommand(state, [{ op: "tombstone_node", nodeKey: IDEA,
    expectedEntityRevision: state.graph.getNodeAttribute(IDEA, "entityRevision") }], "patch-tombstone-node-0001"));
  for (const key of edgesBefore.keys()) assert.equal(state.graph.getEdgeAttribute(key, "status"), "tombstoned");
  const puts = state.history.at(-1).forwardPatch;
  assert.ok(puts.some(({ op, key }) => op === "put_node" && key === IDEA));
  for (const [key, attributes] of edgesBefore) {
    if (attributes.status === "active") assert.ok(puts.some((put) => put.op === "put_edge" && put.key === key));
  }
  await undoLastHumanChange(state);
  assert.deepEqual(semanticDigests(state), before);
  for (const [key, attributes] of edgesBefore) assert.deepEqual(state.graph.getEdgeAttributes(key), attributes);
});

test("reader creation and removal share patches, with exact minted-anchor removal and restoration on Undo/Redo", async () => {
  const state = await fixture();
  const before = semanticDigests(state);
  const anchor = await mintReaderAnchor(state, { pageIndex: 0, sourceKind: "exact_text", normalizedBounds: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.05 }],
    pageViewBox: [0, 0, 612, 792], pageRotation: 0, exactText: "A real page-owned reader selection." });
  const created = await applyReaderAnnotation(state, { baseWorkspaceRevision: state.workspaceRevision, baseWorkspaceDigest: state.workspaceDigest,
    anchor, annotation: { kind: "question", body: "What does this mean?" },
    node: { kind: "concept", label: "Reader question", summary: "Reader-authored context", salience: 0.5 } });
  assert.equal(created.status, "applied_reversible");
  assertCanonicalRevision(state.history.at(-1), { kind: "reader_annotation_graph" });
  assert.deepEqual(new Set(state.history.at(-1).forwardPatch.map(({ op }) => op)), new Set(["put_anchor", "put_node", "put_edge", "put_annotation"]));
  const afterCreate = semanticDigests(state);
  await undoLastHumanChange(state);
  assert.equal(state.anchors.has(anchor.anchorId), false);
  assert.equal(state.graph.hasNode(created.nodeKey), false);
  assert.equal(state.annotations.has(created.annotationId), false);
  assert.deepEqual(semanticDigests(state), before);
  await redoLastHumanChange(state);
  assert.deepEqual(state.anchors.get(anchor.anchorId), anchor);
  assert.deepEqual(semanticDigests(state), afterCreate);
  await removeReaderAnnotation(state, created.annotationId);
  assertCanonicalRevision(state.history.at(-1), { kind: "reader_annotation_removal" });
  assert.equal(state.history.at(-1).forwardPatch.some(({ op }) => op === "put_anchor"), false);
  assert.equal(state.anchors.has(anchor.anchorId), true);
  await undoLastHumanChange(state);
  assert.deepEqual(semanticDigests(state), afterCreate);
});

test("mixed graph and annotation sequences invert/reapply by digest across deterministic varied edits", async () => {
  for (let seed = 1; seed <= 5; seed += 1) {
    const state = await fixture();
    const states = [semanticDigests(state)];
    for (let step = 0; step < 8; step += 1) {
      const key = `property-${seed}-step-${step}-0001`;
      if ((step + seed) % 3 === 0) {
        await applied(state, "apply_annotation", annotationCommand(state, key));
      } else if ((step + seed) % 3 === 1) {
        await applied(state, "apply_graph", graphCommand(state, [addNode(`client:seed${seed}:step${step}`)], key));
      } else {
        await applied(state, "apply_graph", graphCommand(state, [{ op: "update_node", nodeKey: IDEA,
          expectedEntityRevision: state.graph.getNodeAttribute(IDEA, "entityRevision"), set: { label: `Meaning ${seed}-${step}`, salience: (seed + step) / 20 } }], key));
      }
      assertCanonicalRevision(state.history.at(-1));
      states.push(semanticDigests(state));
    }
    const appliedCount = state.revisions.length;
    for (let index = states.length - 2; index >= 0; index -= 1) {
      assert.equal((await undoLastHumanChange(state)).status, "undone");
      assert.deepEqual(semanticDigests(state), states[index], `Undo seed ${seed}, index ${index}`);
    }
    for (let index = 1; index < states.length; index += 1) {
      assert.equal((await redoLastHumanChange(state)).status, "redone");
      assert.deepEqual(semanticDigests(state), states[index], `Redo seed ${seed}, index ${index}`);
    }
    assert.equal(state.revisions.length, appliedCount + 16);
  }
});

test("idempotency replay after Undo does not reapply or append revisions and conflicting reuse is a no-op", async () => {
  const state = await fixture();
  const command = graphCommand(state);
  const first = await applied(state, "apply_graph", command);
  await undoLastHumanChange(state);
  const before = boundary(state, { events: false });
  const replay = await tool(state, "apply_graph").execute(command);
  assert.equal(replay.status, "replayed");
  assert.equal(replay.revisionId, first.revisionId);
  assert.equal(boundary(state, { events: false }), before);
  const conflictBefore = boundary(state);
  const conflict = await tool(state, "apply_graph").execute({ ...command, reason: "A different intent under the same key" });
  assert.equal(conflict.status, "rejected");
  assert.equal(conflict.code, "idempotency_conflict");
  assert.equal(boundary(state), conflictBefore);
});

test("a divergent annotation edit clears Redo without deleting the historical apply/undo ledger", async () => {
  const state = await fixture();
  await applied(state, "apply_graph", graphCommand(state));
  await undoLastHumanChange(state);
  const retained = structuredClone(state.revisions);
  await applied(state, "apply_annotation", annotationCommand(state));
  assert.equal(state.redoHistory.length, 0);
  assert.deepEqual(state.revisions.slice(0, retained.length), retained);
  const before = boundary(state);
  assert.equal((await redoLastHumanChange(state)).status, "nothing_to_redo");
  assert.equal(boundary(state), before);
});

test("stale graph/annotation commands preserve every ledger, replay cache, and history field", async () => {
  const state = await fixture();
  const staleGraph = graphCommand(state, [addNode()], "stale-graph-command-0001");
  const staleAnnotation = annotationCommand(state, "stale-annotation-command-0001");
  await applied(state, "apply_graph", graphCommand(state, [addNode()], "fresh-graph-command-0001"));
  for (const [name, command] of [["apply_graph", staleGraph], ["apply_annotation", staleAnnotation]]) {
    const before = boundary(state);
    const result = await tool(state, name).execute(command);
    assert.equal(result.status, "rejected");
    assert.equal(result.code, "stale_workspace");
    assert.equal(boundary(state), before);
  }
});

test("out-of-band semantic drift cannot be legitimized by a new revision with stale cached digests", async () => {
  for (const name of ["apply_graph", "apply_annotation"]) {
    const state = await fixture();
    await applied(state, "apply_graph", graphCommand(state, [addNode()], "drift-baseline-command-0001"));
    const command = name === "apply_graph" ? graphCommand(state, [addNode()], "drift-next-graph-command-0001")
      : annotationCommand(state, "drift-next-annotation-command-0001");
    // Simulates an integration bug that changes semantics without passing the
    // shared reducer. A valid cached envelope must not bless the wrong before state.
    state.graph.setNodeAttribute(IDEA, "label", "Untracked semantic drift");
    const before = boundary(state);
    const result = await tool(state, name).execute(command);
    assert.equal(result.status, "rejected", name);
    assert.equal(boundary(state), before, name);
    assert.equal(state.requestResults.has(command.idempotencyKey), false);
  }
});

test("explicit node restoration does not resurrect independently tombstoned incident edges", async () => {
  const state = await fixture();
  await applied(state, "apply_graph", graphCommand(state, [{ op: "tombstone_edge", edgeKey: EDGE,
    expectedEntityRevision: state.graph.getEdgeAttribute(EDGE, "entityRevision") }], "restore-edge-baseline-command-0001"));
  await applied(state, "apply_graph", graphCommand(state, [{ op: "tombstone_node", nodeKey: IDEA,
    expectedEntityRevision: state.graph.getNodeAttribute(IDEA, "entityRevision") }], "restore-node-tombstone-command-0001"));
  const edgeBefore = structuredClone(state.graph.getEdgeAttributes(EDGE));
  await applied(state, "apply_graph", graphCommand(state, [{ op: "restore_node", nodeKey: IDEA,
    expectedEntityRevision: state.graph.getNodeAttribute(IDEA, "entityRevision") }], "restore-node-command-0001"));
  assert.equal(state.graph.getNodeAttribute(IDEA, "status"), "active");
  assert.deepEqual(state.graph.getEdgeAttributes(EDGE), edgeBefore);
  assert.deepEqual(state.history.at(-1).forwardPatch.map(({ op }) => op), ["put_node"]);
  await undoLastHumanChange(state);
  assert.equal(state.graph.getNodeAttribute(IDEA, "status"), "tombstoned");
  assert.deepEqual(state.graph.getEdgeAttributes(EDGE), edgeBefore);
});

test("stale Undo/Redo digest heads reject atomically instead of restoring an unrelated snapshot", async () => {
  for (const direction of ["undo", "redo"]) {
    const state = await fixture();
    await applied(state, "apply_graph", graphCommand(state));
    if (direction === "redo") await undoLastHumanChange(state);
    const stack = direction === "undo" ? state.history : state.redoHistory;
    const field = direction === "undo" ? "afterWorkspaceDigest" : "beforeWorkspaceDigest";
    stack[stack.length - 1] = { ...stack.at(-1), [field]: "f".repeat(64) };
    const before = boundary(state);
    await assert.rejects(direction === "undo" ? undoLastHumanChange(state) : redoLastHumanChange(state));
    assert.equal(boundary(state), before);
  }
});

test("tampered inverse records cannot replace protected structure and leave live state/history intact", async () => {
  const state = await fixture();
  await applied(state, "apply_graph", graphCommand(state));
  const head = structuredClone(state.history.at(-1));
  const root = { key: "node:paper", ...state.graph.getNodeAttributes("node:paper") };
  for (const key of ["x", "y", "size", "color", "hidden", "selected", "highlighted", "hovered"]) delete root[key];
  head.inversePatch.push({ op: "put_node", key: "node:paper", before: root, after: { ...root, label: "Injected structure" } });
  state.history[state.history.length - 1] = head;
  const before = boundary(state);
  await assert.rejects(undoLastHumanChange(state));
  assert.equal(boundary(state), before);
});

test("generated node, edge, and annotation ID collisions never replace current entities or produce receipts", async () => {
  for (const family of ["node", "edge", "annotation"]) {
    const state = await fixture();
    const annotation = await applied(state, "apply_annotation", annotationCommand(state, `collision-setup-${family}-0001`));
    const existingId = family === "node" ? IDEA : family === "edge" ? EDGE : annotation.affected.created[0];
    const originalId = state.id;
    state.id = (prefix) => prefix === `${family}:agent` ? existingId : originalId(prefix);
    const command = family === "annotation" ? annotationCommand(state, "colliding-annotation-0001")
      : graphCommand(state, family === "node" ? [addNode()] : [addEdge("client:collision", { refType: "issued_key", key: IDEA }, { refType: "issued_key", key: "node:paper" })], `colliding-${family}-command-0001`);
    const before = boundary(state, { events: false });
    const result = await tool(state, family === "annotation" ? "apply_annotation" : "apply_graph").execute(command);
    assert.notEqual(result.status, "applied_reversible");
    assert.equal(boundary(state, { events: false }), before);
    assert.equal(state.requestResults.has(command.idempotencyKey), false);
  }
});

test("invalid source/authority and raw trusted patches are rejected before canonical history is touched", async () => {
  for (const variation of ["missing_source", "foreign_source", "structural_authority", "trusted_patch", "wrong_anchor_digest"]) {
    const state = await fixture();
    let name = "apply_graph";
    let command = graphCommand(state);
    if (variation === "missing_source") command.operations[0].node.sourceAnchorIds = [];
    if (variation === "foreign_source") command.operations[0].node.sourceAnchorIds = ["anchor:foreign"];
    if (variation === "structural_authority") command.operations[0].node.authority = "document_structure";
    if (variation === "trusted_patch") command.forwardPatch = [{ op: "put_node", key: IDEA, before: null, after: null }];
    if (variation === "wrong_anchor_digest") {
      name = "apply_annotation"; command = annotationCommand(state);
      command.operations[0].expectedAnchorDigest = "a".repeat(64);
    }
    const before = boundary(state);
    const result = await tool(state, name).execute(command);
    assert.equal(result.status, "rejected", variation);
    assert.equal(boundary(state), before, variation);
  }
});

test("projection failure rolls back the revision ledger, both stacks, replay cache, and semantic state together", async () => {
  for (const name of ["apply_graph", "apply_annotation"]) {
    const state = await fixture();
    await applied(state, "apply_graph", graphCommand(state, [addNode()], "rollback-kept-history-0001"));
    await applied(state, "apply_annotation", annotationCommand(state, "rollback-kept-redo-0001"));
    await undoLastHumanChange(state);
    const before = boundary(state, { events: false });
    const eventsBefore = structuredClone(state.events);
    const command = name === "apply_graph" ? graphCommand(state, [addNode()], "rollback-new-graph-0001") : annotationCommand(state, "rollback-new-annotation-0001");
    let projectionCalls = 0;
    state.onStateChange = async () => { if (++projectionCalls === 1) throw new Error("PRIVATE C:\\workspace\\internal-path"); };
    const failed = await tool(state, name).execute(command);
    assert.equal(failed.status, "rolled_back");
    assert.equal(boundary(state, { events: false }), before);
    assert.deepEqual(state.events.slice(0, eventsBefore.length), eventsBefore);
    assert.equal(state.events.at(-1).eventType, "graph_rolled_back");
    assert.doesNotMatch(JSON.stringify(failed), /PRIVATE|internal-path/u);
    assert.equal(state.requestResults.has(command.idempotencyKey), false);
    const ledgerCount = state.revisions.length;
    const retried = await applied(state, name, command);
    assert.equal(retried.replayed, false);
    assert.equal(state.revisions.length, ledgerCount + 1);
    assert.equal(state.redoHistory.length, 0);
  }
});

test("pre-commit event failure cannot leave a phantom revision or poison a genuine same-key retry", async () => {
  const state = await fixture();
  const command = annotationCommand(state);
  const before = boundary(state, { events: false });
  const originalId = state.id;
  let injected = false;
  state.id = (prefix) => {
    if (prefix === "event" && !injected) { injected = true; throw new Error("Injected event allocation failure"); }
    return originalId(prefix);
  };
  const result = await tool(state, "apply_annotation").execute(command);
  assert.equal(result.status, "rolled_back");
  assert.equal(boundary(state, { events: false }), before);
  assert.equal(state.requestResults.has(command.idempotencyKey), false);
  const retry = await applied(state, "apply_annotation", command);
  assert.equal(retry.replayed, false);
  assert.equal(state.history.length, 1);
});

test("failed human Undo/Redo projection preserves the append-only ledger and both stacks for retry", async () => {
  for (const direction of ["undo", "redo"]) {
    const state = await fixture();
    await applied(state, "apply_graph", graphCommand(state));
    await applied(state, "apply_annotation", annotationCommand(state));
    if (direction === "redo") await undoLastHumanChange(state);
    const reverse = direction === "undo" ? undoLastHumanChange : redoLastHumanChange;
    const before = boundary(state, { events: false });
    const priorLedger = structuredClone(state.revisions);
    let calls = 0;
    state.onStateChange = async () => { if (++calls === 1) throw new Error("PRIVATE reverse projection failure"); };
    await assert.rejects(reverse(state), (error) => error.code === "workspace_rolled_back" && !/PRIVATE/u.test(error.message));
    assert.equal(boundary(state, { events: false }), before);
    assert.equal(state.events.at(-1).eventType, "graph_rolled_back");
    const retried = await reverse(state);
    assert.equal(retried.status, direction === "undo" ? "undone" : "redone");
    assert.equal(state.revisions.length, priorLedger.length + 1);
    assert.deepEqual(state.revisions.slice(0, priorLedger.length), priorLedger);
  }
});

test("IDs retained only in a reversed or migrated revision cannot be recycled by a divergent edit", async () => {
  for (const migrated of [false, true]) for (const family of ["node", "annotation"]) {
    const state = await fixture();
    const name = family === "node" ? "apply_graph" : "apply_annotation";
    const command = family === "node" ? graphCommand(state) : annotationCommand(state);
    const created = await applied(state, name, command);
    const previousId = created.affected.created[0];
    await undoLastHumanChange(state);
    if (migrated) state.revisions = []; // Validated v2 migration cannot fabricate a historical patch ledger.
    assert.equal(family === "node" ? state.graph.hasNode(previousId) : state.annotations.has(previousId), false);
    const originalId = state.id;
    state.id = (prefix) => prefix === `${family}:agent` ? previousId : originalId(prefix);
    const nextCommand = family === "node" ? graphCommand(state, [addNode()], "recycled-node-command-0001")
      : annotationCommand(state, "recycled-annotation-command-0001");
    const before = boundary(state);
    const result = await tool(state, name).execute(nextCommand);
    assert.equal(result.status, "rejected");
    assert.equal(result.code, "generated_id_collision");
    assert.equal(boundary(state), before);
  }
});

test("reader anchor evidence stays deeply immutable when patch-based Undo/Redo reinstalls the workspace", async () => {
  const state = await fixture();
  const anchor = await mintReaderAnchor(state, { pageIndex: 0, sourceKind: "exact_text", normalizedBounds: [{ x: 0.12, y: 0.3, width: 0.3, height: 0.05 }],
    pageViewBox: [0, 0, 612, 792], pageRotation: 0, exactText: "Immutable reader source evidence." });
  await applyReaderAnnotation(state, { baseWorkspaceRevision: state.workspaceRevision, baseWorkspaceDigest: state.workspaceDigest,
    anchor, annotation: { kind: "highlight", label: "Immutable evidence" },
    node: { kind: "concept", label: "Reader evidence", summary: "Reader source context", salience: 0.5 } });
  const exactEvidence = structuredClone(state.anchors.get(anchor.anchorId));
  await applied(state, "apply_graph", graphCommand(state));
  for (const reverse of [undoLastHumanChange, redoLastHumanChange]) {
    await reverse(state);
    const retained = state.anchors.get(anchor.anchorId);
    assert.deepEqual(retained, exactEvidence);
    assert.equal(Object.isFrozen(retained), true);
    assert.equal(Object.isFrozen(retained.normalizedBounds), true);
    assert.equal(Object.isFrozen(retained.normalizedBounds[0]), true);
    assert.throws(() => { retained.normalizedBounds[0].x = 0.9; }, TypeError);
  }
});

test("a failing projection cannot leak nested graph source or coverage edits across rollback", async () => {
  const state = await fixture();
  const before = boundary(state, { events: false });
  let calls = 0;
  state.onStateChange = (live) => {
    if (++calls !== 1) return;
    live.graph.getNodeAttributes("node:concept:attention").sourceAnchorIds.push("anchor:visual:a");
    live.graph.getNodeAttributes("node:paper").structuralCoverage[0].endPageIndex = 0;
    live.graph.getEdgeAttributes(live.graph.edges()[0]).sourceAnchorIds.push("anchor:visual:a");
    throw new Error("Projection failed after mutating nested attributes");
  };
  const result = await tool(state, "apply_graph").execute(graphCommand(state));
  assert.equal(result.status, "rolled_back");
  assert.equal(boundary(state, { events: false }), before);
  assert.equal((await applied(state, "apply_graph", graphCommand(state))).status, "applied_reversible");
});
