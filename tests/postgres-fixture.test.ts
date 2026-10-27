import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
test("PostgreSQL fixture refuses unapproved, absent, remote and query-bearing targets before connecting", () => {
  for (const [flag, url] of [
    ["", "postgresql://postgres:fixture@127.0.0.1:5432/resources_ci"],
    ["1", ""],
    ["1", "postgresql://postgres:fixture@example.invalid/resources_ci"],
    [
      "1",
      "postgresql://postgres:fixture@127.0.0.1:5432/resources_ci?sslmode=disable",
    ],
  ]) {
    const r = spawnSync(
      process.execPath,
      ["integration/postgres-budgets.test.ts"],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          RCO_TEST_DISPOSABLE_POSTGRES: flag!,
          RCO_TEST_ADMIN_URL: url!,
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(r.error, undefined);
    assert.notEqual(r.status, 0);
    assert.match(
      r.stdout + r.stderr,
      /Explicit disposable|Only the designated empty loopback/,
    );
  }
});
