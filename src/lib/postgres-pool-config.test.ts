import assert from "node:assert/strict";
import test from "node:test";

import { paperPilotDatabasePoolMaxFromEnvironment } from "./postgres-pool-config";

test("the serverless database pool is exactly one connection per instance", () => {
  assert.equal(paperPilotDatabasePoolMaxFromEnvironment({}), 1);
  assert.equal(paperPilotDatabasePoolMaxFromEnvironment({ DATABASE_POOL_MAX: "" }), 1);
  assert.equal(
    paperPilotDatabasePoolMaxFromEnvironment({ DATABASE_POOL_MAX: "1" }),
    1,
  );
  for (const value of ["0", "2", "01", "+1", "1.0", " 1", "1 ", "nope"]) {
    assert.throws(
      () => paperPilotDatabasePoolMaxFromEnvironment({ DATABASE_POOL_MAX: value }),
      /must be exactly 1/,
    );
  }
});
