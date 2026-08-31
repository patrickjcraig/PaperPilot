import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_VISIBLE_ACTIVITY_LIMIT,
  boundActivityForDisplay,
  createActivityRecord,
  formatActivityEvent,
  formatActivityForDisplay,
  humanReadable,
  mergeRestoredActivity,
  presentedActor,
} from "./activity-ledger.mjs";

test("activity record creation is deterministic, copied, and preserves details precedence", () => {
  const details = {
    actor: "human",
    eventType: "restored_event",
    observedAt: "2026-08-31T12:00:02.000Z",
  };
  const record = createActivityRecord(
    "live_event",
    details,
    "2026-08-31T12:00:01.000Z",
  );

  assert.deepEqual(record, {
    observedAt: "2026-08-31T12:00:02.000Z",
    eventType: "restored_event",
    actor: "human",
  });
  assert.notEqual(record, details);
  assert.deepEqual(details, {
    actor: "human",
    eventType: "restored_event",
    observedAt: "2026-08-31T12:00:02.000Z",
  });
});

test("reader-facing value and actor formatting retain current aliases and casing", () => {
  assert.equal(humanReadable("graph_layout_changed"), "graph layout changed");
  assert.equal(humanReadable("Already_Mixed"), "Already Mixed");
  assert.equal(humanReadable(null), "");

  assert.equal(presentedActor("agent"), "WebMCP caller");
  assert.equal(presentedActor("webmcp_caller"), "WebMCP caller");
  assert.equal(presentedActor("WebMCP caller"), "WebMCP caller");
  assert.equal(presentedActor("page"), "PaperPilot page");
  assert.equal(presentedActor("PaperPilot page"), "PaperPilot page");
  assert.equal(presentedActor("human"), "Human");
  assert.equal(presentedActor("automatic_map"), "automatic map");
  assert.equal(presentedActor(undefined), "");
});

test("one activity row preserves the public list's exact segment formatting", () => {
  assert.equal(
    formatActivityEvent({
      observedAt: "2026-08-31T12:00:00.000Z",
      eventType: "page_callback_returned",
      actor: "agent",
      toolName: "paperpilot.read_graph",
      status: "applied_reversible",
    }),
    "2026-08-31T12:00:00.000Z · page callback returned · WebMCP caller · paperpilot.read_graph · applied_reversible",
  );
  assert.equal(
    formatActivityEvent({ observedAt: "t0", eventType: "pdf_loaded" }),
    "t0 · pdf loaded",
  );
});

test("restored activity deduplicates only truthy IDs and preserves id-less repeats", () => {
  const current = [
    { eventId: "event:current", observedAt: "2026-08-31T12:00:02.000Z", eventType: "graph_read" },
    { observedAt: "2026-08-31T12:00:03.000Z", eventType: "idless_repeat" },
  ];
  const restored = [
    { eventId: "event:current", observedAt: "2026-08-31T12:00:00.000Z", eventType: "duplicate_old" },
    { eventId: "event:restored", observedAt: "2026-08-31T12:00:01.000Z", eventType: "focus_read" },
    { eventId: "event:restored", observedAt: "2026-08-31T12:00:04.000Z", eventType: "duplicate_new" },
    { observedAt: "2026-08-31T12:00:03.000Z", eventType: "idless_repeat" },
  ];

  const result = mergeRestoredActivity({ current, restored });

  assert.deepEqual(result.map((event) => event.eventType), [
    "focus_read",
    "graph_read",
    "idless_repeat",
    "idless_repeat",
  ]);
  assert.deepEqual(result.filter((event) => event.eventId === "event:restored").length, 1);
  assert.deepEqual(current.map((event) => event.eventType), ["graph_read", "idless_repeat"]);
  assert.deepEqual(restored.map((event) => event.eventType), [
    "duplicate_old",
    "focus_read",
    "duplicate_new",
    "idless_repeat",
  ]);
  assert.notEqual(result.find((event) => event.eventId === "event:current"), current[0]);
  assert.notEqual(result.find((event) => event.eventId === "event:restored"), restored[1]);
});

test("existing duplicate IDs remain while later restored copies are suppressed", () => {
  const result = mergeRestoredActivity({
    current: [
      { eventId: "event:same", observedAt: "t1", eventType: "existing_one" },
      { eventId: "event:same", observedAt: "t2", eventType: "existing_two" },
    ],
    restored: [
      { eventId: "event:same", observedAt: "t0", eventType: "restored_duplicate" },
    ],
  });

  assert.deepEqual(result.map((event) => event.eventType), ["existing_one", "existing_two"]);
});

test("restored merge keeps the old missing-time and stable equal-time ordering", () => {
  const result = mergeRestoredActivity({
    current: [
      { eventId: "event:current-a", observedAt: "same", eventType: "current_a" },
      { eventId: "event:current-b", observedAt: "same", eventType: "current_b" },
    ],
    restored: [
      { eventId: "event:missing-time", eventType: "missing_time" },
      { eventId: "event:restored-a", observedAt: "same", eventType: "restored_a" },
      { eventId: "event:restored-b", observedAt: "same", eventType: "restored_b" },
    ],
  });

  assert.deepEqual(result.map((event) => event.eventType), [
    "missing_time",
    "current_a",
    "current_b",
    "restored_a",
    "restored_b",
  ]);
});

test("display bounding selects the newest records, reverses them, and leaves input intact", () => {
  const events = Array.from({ length: DEFAULT_VISIBLE_ACTIVITY_LIMIT + 5 }, (_, index) => ({
    eventId: `event:${index}`,
    observedAt: String(index).padStart(3, "0"),
    eventType: `event_${index}`,
  }));
  const before = structuredClone(events);

  const visible = boundActivityForDisplay(events);

  assert.equal(visible.length, DEFAULT_VISIBLE_ACTIVITY_LIMIT);
  assert.equal(visible[0].eventType, "event_84");
  assert.equal(visible.at(-1).eventType, "event_5");
  assert.deepEqual(events, before);
  assert.deepEqual(boundActivityForDisplay(events, 2).map((event) => event.eventType), ["event_84", "event_83"]);
  assert.deepEqual(boundActivityForDisplay(events, 0), []);
  assert.deepEqual(boundActivityForDisplay(events, Number.NaN), []);
});

test("bounded display formatting composes without a DOM fixture", () => {
  const events = [
    { observedAt: "t1", eventType: "pdf_loaded", actor: "page" },
    { observedAt: "t2", eventType: "explanation_saved", actor: "human", status: "saved" },
  ];

  assert.deepEqual(formatActivityForDisplay(events, 1), [
    "t2 · explanation saved · Human · saved",
  ]);
});
