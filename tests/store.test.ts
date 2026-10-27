import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { scoped, verifyAudit } from "@accountability/evidence/database";
import type { Database } from "@accountability/evidence/database";
import { BudgetStore } from "../src/store.ts";
import type { ReceiptVerifier } from "../src/store.ts";
import { DomainError, canonical, digest } from "../src/contracts.ts";
import { budgetBalance, reserve } from "../src/index.ts";
import type { Context } from "../src/contracts.ts";
const owner: Context = {
  tenantId: "alpha",
  projectId: "study",
  actor: { id: "owner", kind: "human", roles: ["owner"] },
  purpose: "research",
  requestId: "r",
  now: "2026-01-01T00:00:00Z",
};
const agent: Context = {
  ...owner,
  actor: { id: "worker", kind: "agent", roles: [] },
};
const budget = {
  id: "budget",
  unit: "credits",
  limit: 100,
  operators: [
    { id: "owner", kind: "human" as const },
    { id: "worker", kind: "agent" as const },
  ],
};
const reservation = {
  id: "reservation",
  units: 60,
  purpose: "research",
  expiresAt: "2026-01-01T00:01:00Z",
  effectKey: "effect-1",
};
const receipt = {
  tenantId: "alpha",
  projectId: "study",
  kind: "provider-receipt",
  id: "verified",
  revision: 1,
};
const verifier: ReceiptVerifier = {
  verify: async (check) =>
    check.receipt.id === "verified" &&
    check.effectKey === "effect-1" &&
    check.unit === "credits" &&
    check.actualUnits >= 0,
};
async function setup(t: test.TestContext, verify = verifier) {
  const pg = new PGlite();
  await pg.exec(
    await readFile(
      new URL(
        "../migrations/001_foundation.sql",
        import.meta.resolve("@accountability/evidence/database"),
      ),
      "utf8",
    ),
  );
  await pg.exec(
    "CREATE ROLE budget_test_login LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION; GRANT evidence_runtime TO budget_test_login; SET SESSION AUTHORIZATION budget_test_login",
  );
  const db: Database = {
    transaction: (fn) =>
      pg.transaction((q) =>
        fn({
          query: async <T>(sql: string, v?: unknown[]) => ({
            rows: (await q.query(sql, v)).rows as T[],
          }),
        }),
      ),
    close: () => pg.close(),
  };
  t.after(() => pg.close());
  const store = new BudgetStore(
    db,
    { tenantId: "alpha", projectId: "study", managerIds: ["owner"] },
    verify,
  );
  const snapshot = await store.create(owner, budget, "create");
  return { pg, db, store, snapshot };
}
async function committed(store: BudgetStore) {
  const reserved = await store.execute(
    agent,
    "budget",
    1,
    { type: "reserve", input: reservation },
    "reserve",
  );
  return store.execute(
    agent,
    "budget",
    reserved.revision,
    { type: "commit", reservationId: "reservation" },
    "commit",
  );
}
test("create/reserve/settle atomically preserve balances revisions audit and change jobs", async (t) => {
  const { store, db } = await setup(t);
  const ready = await committed(store);
  const permit = await store.consumeEffect(
    agent,
    "budget",
    ready.revision,
    "reservation",
  );
  assert.equal(permit.maximumUnits, 60);
  const after = await store.execute(
    agent,
    "budget",
    permit.revision,
    { type: "settle", reservationId: "reservation", actualUnits: 45, receipt },
    "settle",
  );
  assert.equal(budgetBalance(after.state).spent, 45);
  assert.equal(budgetBalance(after.state).reserved, 0);
  await scoped(db, owner, async (tx) => {
    assert.ok(verifyAudit(await tx.audits()));
    assert.equal((await tx.list("budget")).length, 1);
    assert.equal((await tx.claim("worker"))?.topic, "budget.changed");
  });
});
test("one stale contender cannot overspend a shared revision and command replay cannot duplicate its charge", async (t) => {
  const { store } = await setup(t);
  const command = { type: "reserve" as const, input: reservation };
  const results = await Promise.allSettled([
    store.execute(agent, "budget", 1, command, "one"),
    store.execute(
      agent,
      "budget",
      1,
      {
        type: "reserve",
        input: { ...reservation, id: "other", effectKey: "other-effect" },
      },
      "two",
    ),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    budgetBalance((await store.load(agent, "budget")).state).available,
    40,
  );
  const successful = results.findIndex((x) => x.status === "fulfilled");
  const id = successful === 0 ? "one" : "two";
  const cmd =
    successful === 0
      ? command
      : {
          type: "reserve" as const,
          input: { ...reservation, id: "other", effectKey: "other-effect" },
        };
  assert.deepEqual(
    await store.execute(agent, "budget", 1, cmd, id),
    (results[successful] as PromiseFulfilledResult<unknown>).value,
  );
  await assert.rejects(
    store.execute(
      agent,
      "budget",
      2,
      {
        type: "reserve",
        input: {
          ...reservation,
          id: "third",
          effectKey: "third-effect",
          units: 50,
        },
      },
      "three",
    ),
    { code: "budget_exhausted" },
  );
});
test("effect consumption cannot replay after successful or lost acknowledgement and remains reserved", async (t) => {
  const { store, db } = await setup(t);
  const ready = await committed(store);
  let rejectAfterCommit = true;
  const lossy: Database = {
    transaction: async (fn) => {
      const result = await db.transaction(fn);
      if (rejectAfterCommit) {
        rejectAfterCommit = false;
        throw new Error("lost acknowledgement");
      }
      return result;
    },
    close: async () => {},
  };
  const uncertain = new BudgetStore(
    lossy,
    { tenantId: "alpha", projectId: "study", managerIds: ["owner"] },
    verifier,
  );
  await assert.rejects(
    uncertain.consumeEffect(agent, "budget", ready.revision, "reservation"),
    /lost acknowledgement/,
  );
  const current = await store.load(agent, "budget");
  assert.equal(current.state.reservations[0]!.status, "uncertain");
  assert.equal(budgetBalance(current.state).reserved, 60);
  await assert.rejects(
    store.consumeEffect(agent, "budget", current.revision, "reservation"),
    { code: "effect_consumed" },
  );
  await assert.rejects(
    store.consumeEffect(agent, "budget", ready.revision, "reservation"),
    { code: "revision_conflict" },
  );
});
test("unverified release or settlement cannot free an attempted reservation and verifier failure rolls back", async (t) => {
  const { store } = await setup(t);
  const ready = await committed(store);
  const unknown = { ...receipt, id: "unverified" };
  await assert.rejects(
    store.execute(
      agent,
      "budget",
      ready.revision,
      {
        type: "settle",
        reservationId: "reservation",
        actualUnits: 1,
        receipt: unknown,
      },
      "bad",
    ),
    { code: "receipt_denied" },
  );
  await assert.rejects(
    store.execute(
      agent,
      "budget",
      ready.revision,
      { type: "release", reservationId: "reservation", proof: null },
      "release",
    ),
    { code: "receipt_required" },
  );
  assert.equal((await store.load(agent, "budget")).revision, ready.revision);
  assert.equal(
    budgetBalance((await store.load(agent, "budget")).state).reserved,
    60,
  );
});
test("tenant project operator and purpose boundaries are checked before effect authority is issued", async (t) => {
  const { store } = await setup(t);
  for (const c of [
    { ...agent, tenantId: "beta" },
    { ...agent, projectId: "other" },
    { ...agent, actor: { ...agent.actor, id: "unknown" } },
  ])
    await assert.rejects(store.load(c, "budget"));
  const ready = await committed(store);
  await assert.rejects(
    store.consumeEffect(
      { ...agent, purpose: "publication" },
      "budget",
      ready.revision,
      "reservation",
    ),
    { code: "purpose_denied" },
  );
  await assert.rejects(
    store.execute(
      agent,
      "budget",
      ready.revision,
      {
        type: "settle",
        reservationId: "reservation",
        actualUnits: 1,
        receipt: { ...receipt, tenantId: "beta" },
      },
      "foreign",
    ),
    { code: "scope_denied" },
  );
});
test("overage requires verified actual charge and owner authority, preserving real spend beyond the ceiling", async (t) => {
  const { store } = await setup(t);
  const ready = await committed(store);
  await assert.rejects(
    store.execute(
      agent,
      "budget",
      ready.revision,
      {
        type: "overage",
        reservationId: "reservation",
        actualUnits: 120,
        receipt,
        reason: "Provider exceeded ceiling",
      },
      "agent-overage",
    ),
    { code: "owner_required" },
  );
  const reconciled = await store.execute(
    owner,
    "budget",
    ready.revision,
    {
      type: "overage",
      reservationId: "reservation",
      actualUnits: 120,
      receipt,
      reason: "Provider exceeded ceiling",
    },
    "owner-overage",
  );
  assert.equal(budgetBalance(reconciled.state).overLimit, true);
  assert.equal(budgetBalance(reconciled.state).spent, 120);
});
test("caller context and budget data cannot change across asynchronous storage waits", async (t) => {
  const { store } = await setup(t);
  const c = structuredClone(agent),
    input = structuredClone(reservation);
  const pending = store.execute(
    c,
    "budget",
    1,
    { type: "reserve", input },
    "capture",
  );
  (c as { actor: { id: string } }).actor.id = "tampered";
  input.units = 99;
  const result = await pending;
  assert.equal(result.state.reservations[0]!.units, 60);
  assert.equal(result.state.reservations[0]!.owner.id, "worker");
});

test("receipt timeouts and provider failures remain bounded, private and rollback-safe", async (t) => {
  const { store, db } = await setup(t);
  const ready = await committed(store);
  let aborted = false;
  const blocked = new BudgetStore(
    db,
    {
      tenantId: "alpha",
      projectId: "study",
      managerIds: ["owner"],
      receiptTimeoutMs: 10,
    },
    {
      verify: async (_check, signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise<boolean>(() => {});
      },
    },
  );
  await assert.rejects(
    blocked.execute(
      agent,
      "budget",
      ready.revision,
      {
        type: "settle",
        reservationId: "reservation",
        actualUnits: 40,
        receipt,
      },
      "timeout",
    ),
    { code: "receipt_timeout" },
  );
  assert.equal(aborted, true);
  const failed = new BudgetStore(
    db,
    { tenantId: "alpha", projectId: "study", managerIds: ["owner"] },
    {
      verify: async () => {
        throw new Error("private provider token");
      },
    },
  );
  await assert.rejects(
    failed.execute(
      agent,
      "budget",
      ready.revision,
      {
        type: "settle",
        reservationId: "reservation",
        actualUnits: 40,
        receipt,
      },
      "failure",
    ),
    (error) => {
      assert.equal((error as { code: string }).code, "receipt_unavailable");
      assert.ok(!(error as Error).message.includes("private provider"));
      return true;
    },
  );
  assert.equal((await store.load(agent, "budget")).revision, ready.revision);
});

test("a receipt callback that blocks the event loop beyond its deadline cannot commit a late true result", async (t) => {
  const { store, db } = await setup(t);
  const ready = await committed(store);
  const blocked = new BudgetStore(
    db,
    {
      tenantId: owner.tenantId,
      projectId: owner.projectId,
      managerIds: ["owner"],
      receiptTimeoutMs: 10,
    },
    {
      verify: async () => {
        // The timeout timer cannot run during this wait. A monotonic result gate is required.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
        return true;
      },
    },
  );
  await assert.rejects(
    blocked.execute(
      agent,
      "budget",
      ready.revision,
      {
        type: "settle",
        reservationId: "reservation",
        actualUnits: 40,
        receipt,
      },
      "blocked-result",
    ),
    { code: "receipt_timeout" },
  );
  assert.equal((await store.load(agent, "budget")).revision, ready.revision);
});

test("late asynchronous receipt resolution cannot resume a timed-out settlement or free reserved units", async (t) => {
  const { store, db } = await setup(t),
    ready = await committed(store);
  let finish!: (v: boolean) => void, seen: AbortSignal | undefined;
  const late = new BudgetStore(
    db,
    {
      tenantId: owner.tenantId,
      projectId: owner.projectId,
      managerIds: ["owner"],
      receiptTimeoutMs: 10,
    },
    {
      verify: async (_check, signal) => {
        seen = signal;
        return new Promise((r) => {
          finish = r;
        });
      },
    },
  );
  await assert.rejects(
    late.execute(
      agent,
      "budget",
      ready.revision,
      {
        type: "settle",
        reservationId: "reservation",
        actualUnits: 40,
        receipt,
      },
      "late-result",
    ),
    { code: "receipt_timeout" },
  );
  assert.equal(seen?.aborted, true);
  finish(true);
  await new Promise((r) => setImmediate(r));
  const current = await store.load(agent, "budget");
  assert.equal(current.revision, ready.revision);
  assert.equal(current.state.reservations[0]!.status, "committed");
  assert.equal(budgetBalance(current.state).reserved, 60);
  assert.equal(budgetBalance(current.state).spent, 0);
  await scoped(db, owner, async (tx) =>
    assert.ok(verifyAudit(await tx.audits())),
  );
});

test("receipt verification stays strict, sanitizes callback DomainErrors and closes signals on all exits", async (t) => {
  const { store, db } = await setup(t),
    ready = await committed(store);
  const seen: AbortSignal[] = [];
  for (const mode of ["nonboolean", "exception", "success"]) {
    const port = new BudgetStore(
      db,
      {
        tenantId: owner.tenantId,
        projectId: owner.projectId,
        managerIds: ["owner"],
      },
      {
        verify: async (_check, signal) => {
          seen.push(signal);
          if (mode === "exception")
            throw new DomainError(
              "receipt_timeout",
              "private fixture credential diagnostic",
            );
          return mode === "nonboolean" ? ("true" as unknown as boolean) : true;
        },
      },
    );
    const operation = port.execute(
      agent,
      "budget",
      ready.revision,
      {
        type: "settle",
        reservationId: "reservation",
        actualUnits: 40,
        receipt,
      },
      mode,
    );
    if (mode === "success")
      assert.equal(budgetBalance((await operation).state).spent, 40);
    else
      await assert.rejects(operation, (e) => {
        assert.equal(
          (e as { code: string }).code,
          mode === "exception" ? "receipt_unavailable" : "receipt_denied",
        );
        assert.equal(String(e).includes("private fixture"), false);
        return true;
      });
    assert.equal(seen.at(-1)?.aborted, true);
  }
  assert.equal(seen.length, 3);
  assert.equal(
    (await store.load(agent, "budget")).revision,
    ready.revision + 1,
  );
});

test("budget command replay cannot return another principal kind's cached result", async (t) => {
  const { store } = await setup(t),
    command = { type: "reserve" as const, input: reservation };
  const prior = await store.execute(agent, "budget", 1, command, "reserve");
  await assert.rejects(
    store.execute(
      { ...agent, actor: { ...agent.actor, kind: "human" } },
      "budget",
      1,
      command,
      "reserve",
    ),
    { code: "operator_denied" },
  );
  assert.deepEqual(
    await store.execute(agent, "budget", 1, command, "reserve"),
    prior,
  );
  await store.create(
    owner,
    {
      ...budget,
      id: "dual",
      operators: [...budget.operators, { id: "worker", kind: "service" }],
    },
    "create-dual",
  );
  await store.execute(agent, "dual", 1, command, "dual-reserve");
  // Even when both kinds are legitimate budget readers, the reservation belongs
  // to the original exact principal, not merely an SDK actor_id string.
  await assert.rejects(
    store.execute(
      { ...agent, actor: { ...agent.actor, kind: "service" } },
      "dual",
      1,
      command,
      "dual-reserve",
    ),
    { code: "reservation_denied" },
  );
});

test("budget command replay and new effect reconciliation retain the reservation's purpose boundary", async (t) => {
  const { store } = await setup(t),
    ready = await committed(store);
  const wrong = { ...agent, purpose: "different-purpose" };
  await assert.rejects(
    store.execute(
      wrong,
      "budget",
      2,
      { type: "commit", reservationId: "reservation" },
      "commit",
    ),
    { code: "purpose_denied" },
  );
  await assert.rejects(
    store.execute(
      wrong,
      "budget",
      ready.revision,
      {
        type: "settle",
        reservationId: "reservation",
        actualUnits: 40,
        receipt,
      },
      "foreign-settle",
    ),
    { code: "purpose_denied" },
  );
  assert.equal((await store.load(agent, "budget")).revision, ready.revision);
});

test("budget command replay rechecks current owner role before returning an overage acknowledgement", async (t) => {
  const { store } = await setup(t),
    ready = await committed(store);
  const command = {
    type: "overage" as const,
    reservationId: "reservation",
    actualUnits: 120,
    receipt,
    reason: "fixture excess",
  };
  const prior = await store.execute(
    owner,
    "budget",
    ready.revision,
    command,
    "overage",
  );
  await assert.rejects(
    store.execute(
      { ...owner, actor: { ...owner.actor, roles: [] } },
      "budget",
      ready.revision,
      command,
      "overage",
    ),
    { code: "owner_required" },
  );
  assert.deepEqual(
    await store.execute(owner, "budget", ready.revision, command, "overage"),
    prior,
  );
});

test("budget command replay preserves legacy fingerprints and historical acknowledgements after later revisions", async (t) => {
  const { store, db, snapshot } = await setup(t),
    command = { type: "reserve" as const, input: reservation };
  // Seed the prior public command fingerprint using the actual pinned SDK, not the new guard.
  const prior = await scoped(db, agent, (tx) =>
    tx.idempotent(
      "legacy-reserve",
      JSON.parse(
        canonical({ budgetId: "budget", expectedRevision: 1, command }),
      ),
      async () => {
        const state = reserve(snapshot.state, agent, reservation);
        const row = await tx.put(
          "budget",
          digest({ kind: "budget", id: "budget" }),
          1,
          state,
        );
        return JSON.parse(canonical({ revision: row.revision, state }));
      },
    ),
  );
  assert.deepEqual(
    await store.execute(agent, "budget", 1, command, "legacy-reserve"),
    prior,
  );
  await store.execute(
    agent,
    "budget",
    2,
    { type: "commit", reservationId: "reservation" },
    "later-commit",
  );
  assert.deepEqual(
    await store.execute(agent, "budget", 1, command, "legacy-reserve"),
    prior,
  );
  assert.equal((await store.load(agent, "budget")).revision, 3);
  await scoped(db, owner, async (tx) =>
    assert.ok(verifyAudit(await tx.audits())),
  );
});
