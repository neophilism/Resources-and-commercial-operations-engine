import test from "node:test";
import assert from "node:assert/strict";
import { scoped, verifyAudit } from "@accountability/evidence/database";
import { BudgetStore } from "../src/store.ts";
import type { AllocationInput } from "../src/store.ts";
import { digest } from "../src/contracts.ts";
import {
  setup,
  committed,
  owner,
  agent,
  receipt,
  verifier,
} from "./allocation-fixture.ts";
const lines = [
  { projectId: "project-a", contributorId: "contributor-a", units: 20 },
  { projectId: "project-a", contributorId: "contributor-b", units: 10 },
  { projectId: "project-b", contributorId: "contributor-a", units: 15 },
];
async function settled(t: test.TestContext, total = 45) {
  const f = await setup(t),
    ready = await committed(f.store);
  const snapshot = await f.store.execute(
    agent,
    "budget",
    ready.revision,
    {
      type: "settle",
      reservationId: "reservation",
      actualUnits: total,
      receipt,
    },
    "settle",
  );
  return {
    ...f,
    settled: snapshot,
    input: {
      budgetId: "budget",
      reservationId: "reservation",
      expectedBudgetRevision: snapshot.revision,
      lines: structuredClone(lines),
    } satisfies AllocationInput,
  };
}

test("durable balanced project/contributor allocation binds exact settled budget/receipt/entry without changing balances or history", async (t) => {
  const f = await settled(t),
    before = await f.store.load(owner, "budget"),
    record = await f.store.allocate(owner, f.input, "allocate");
  assert.equal(record.revision, 1);
  assert.deepEqual(record.value.lines, lines);
  assert.equal(record.value.source.totalUnits, 45);
  assert.equal(record.value.source.unit, "credits");
  assert.equal(record.value.source.budget.revision, before.revision);
  assert.equal(
    record.value.source.budget.id,
    digest({ kind: "budget", id: "budget" }),
  );
  assert.deepEqual(record.value.source.receipt, receipt);
  assert.equal(record.value.source.costHash, before.state.entries.at(-1)!.hash);
  assert.equal(record.value.recordedBy, "owner");
  assert.deepEqual(await f.store.load(owner, "budget"), before);
  assert.deepEqual(
    await f.store.loadAllocation(owner, "budget", "reservation"),
    record,
  );
  await scoped(f.db, owner, async (tx) => {
    assert.equal((await tx.list("cost-allocation")).length, 1);
    assert.equal(
      (await tx.audits()).filter((a) => a.type === "cost.allocated").length,
      1,
    );
    assert.ok(verifyAudit(await tx.audits()));
  });
});

test("allocation rejects unbalanced unsafe duplicated unbounded or nonliteral cells and stale source edition", async (t) => {
  const f = await settled(t);
  for (const input of [
    { ...f.input, lines: [{ projectId: "a", contributorId: "a", units: 44 }] },
    { ...f.input, lines: [{ projectId: "a", contributorId: "a", units: -1 }] },
    {
      ...f.input,
      lines: [
        { projectId: "a", contributorId: "a", units: Number.MAX_SAFE_INTEGER },
        { projectId: "b", contributorId: "b", units: 1 },
      ],
    },
    { ...f.input, lines: [lines[0]!, lines[0]!] },
    { ...f.input, lines: [] },
    {
      ...f.input,
      lines: Array.from({ length: 257 }, (_, i) => ({
        projectId: "a",
        contributorId: String(i),
        units: 0,
      })),
    },
    {
      ...f.input,
      lines: [
        { projectId: "a", contributorId: "b", units: 45, token: "excluded" },
      ],
    },
    { ...f.input, expectedBudgetRevision: f.input.expectedBudgetRevision - 1 },
    { ...f.input, sourceTotal: 45 },
  ] as AllocationInput[]) {
    await assert.rejects(
      f.store.allocate(owner, input, "bad-" + digest(input)),
    );
  }
  assert.equal(
    await f.store.loadAllocation(owner, "budget", "reservation"),
    null,
  );
  await scoped(f.db, owner, async (tx) =>
    assert.equal(
      (await tx.audits()).filter((a) => a.type === "cost.allocated").length,
      0,
    ),
  );
});

test("one immutable allocation per settled reservation survives concurrent commands and exact historical replay after later budget revisions", async (t) => {
  const f = await settled(t);
  const result = await Promise.allSettled([
    f.store.allocate(owner, f.input, "one"),
    f.store.allocate(
      owner,
      {
        ...f.input,
        lines: [{ projectId: "other", contributorId: "other", units: 45 }],
      },
      "two",
    ),
  ]);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  const winning =
    result[0]!.status === "fulfilled"
      ? { input: f.input, key: "one" }
      : {
          input: {
            ...f.input,
            lines: [{ projectId: "other", contributorId: "other", units: 45 }],
          },
          key: "two",
        };
  const first = await f.store.allocate(owner, winning.input, winning.key);
  await f.store.execute(
    owner,
    "budget",
    f.settled.revision,
    {
      type: "reserve",
      input: {
        id: "later",
        units: 1,
        purpose: owner.purpose,
        expiresAt: "2026-01-01T00:02:00Z",
        effectKey: "later",
      },
    },
    "later",
  );
  assert.deepEqual(
    await f.store.allocate(owner, winning.input, winning.key),
    first,
  );
  assert.deepEqual(
    await f.store.loadAllocation(owner, "budget", "reservation"),
    first,
  );
  await assert.rejects(
    f.store.allocate(
      owner,
      { ...winning.input, expectedBudgetRevision: f.settled.revision + 1 },
      "new",
    ),
    { code: "already_allocated" },
  );
  await assert.rejects(
    f.store.allocate(
      owner,
      { ...winning.input, expectedBudgetRevision: f.settled.revision + 1 },
      winning.key,
    ),
    { code: "idempotency_conflict" },
  );
});

test("allocation excludes unsettled/released costs and zero-cost settled allocation remains exact and unit-preserving", async (t) => {
  const f = await setup(t),
    ready = await committed(f.store),
    input = {
      budgetId: "budget",
      reservationId: "reservation",
      expectedBudgetRevision: ready.revision,
      lines,
    };
  await assert.rejects(f.store.allocate(owner, input, "unsettled"), {
    code: "cost_unsettled",
  });
  await f.store.execute(
    agent,
    "budget",
    ready.revision,
    { type: "release", reservationId: "reservation", proof: receipt },
    "no-charge",
  );
  await assert.rejects(f.store.allocate(owner, input, "released"), {
    code: "cost_unsettled",
  });
  const z = await settled(t, 0),
    row = await z.store.allocate(
      owner,
      { ...z.input, lines: [{ projectId: "p", contributorId: "c", units: 0 }] },
      "zero",
    );
  assert.equal(row.value.source.totalUnits, 0);
  assert.equal(row.value.source.unit, "credits");
});

test("allocation replay/read require fresh manager role, full current stored operator kind/id and exact purpose/scope", async (t) => {
  const f = await settled(t);
  await f.store.allocate(owner, f.input, "auth");
  for (const c of [
    { ...owner, actor: { ...owner.actor, roles: [] } },
    { ...owner, actor: { ...owner.actor, kind: "service" as const } },
    { ...owner, purpose: "another" },
    { ...owner, projectId: "foreign" },
  ]) {
    await assert.rejects(f.store.allocate(c, f.input, "auth"));
    await assert.rejects(f.store.loadAllocation(c, "budget", "reservation"));
  }
  // Fixture-only stored policy edit, not a new manager administration API.
  await scoped(f.db, owner, async (tx) => {
    const row = await tx.get<any>(
      "budget",
      digest({ kind: "budget", id: "budget" }),
    );
    await tx.put(
      "budget",
      digest({ kind: "budget", id: "budget" }),
      row!.revision,
      {
        ...row!.value,
        operators: [
          { id: "owner", kind: "service" },
          { id: "worker", kind: "agent" },
        ],
      },
    );
  });
  await assert.rejects(f.store.allocate(owner, f.input, "auth"), {
    code: "operator_denied",
  });
  await assert.rejects(f.store.loadAllocation(owner, "budget", "reservation"), {
    code: "operator_denied",
  });
});

test("post-COMMIT allocation acknowledgement loss survives fresh store replay without duplicate allocation or outbox", async (t) => {
  const f = await settled(t);
  let wrote = false,
    lost = false;
  const db = {
    ...f.db,
    transaction: async <T>(fn: Parameters<typeof f.db.transaction<T>>[0]) => {
      const result = await f.db.transaction((q) =>
        fn({
          query: async <R>(sql: string, v?: unknown[]) => {
            const result = await q.query<R>(sql, v);
            if (
              sql.includes("INSERT INTO public.evidence_outbox") &&
              v?.includes("cost.allocated")
            )
              wrote = true;
            return result;
          },
        }),
      );
      if (wrote && !lost) {
        lost = true;
        throw Error("lost allocation COMMIT acknowledgement");
      }
      return result;
    },
  };
  const store = new BudgetStore(
    db,
    {
      tenantId: owner.tenantId,
      projectId: owner.projectId,
      managerIds: ["owner"],
    },
    verifier,
  );
  await assert.rejects(
    store.allocate(owner, f.input, "lost"),
    /lost allocation COMMIT/,
  );
  assert.equal(lost, true);
  const fresh = new BudgetStore(
    f.db,
    {
      tenantId: owner.tenantId,
      projectId: owner.projectId,
      managerIds: ["owner"],
    },
    verifier,
  );
  const row = await fresh.allocate(owner, f.input, "lost");
  assert.deepEqual(
    await fresh.loadAllocation(owner, "budget", "reservation"),
    row,
  );
  await scoped(f.db, owner, async (tx) => {
    assert.equal((await tx.list("cost-allocation")).length, 1);
    assert.equal(
      (await tx.audits()).filter((a) => a.type === "cost.allocated").length,
      1,
    );
    assert.ok(verifyAudit(await tx.audits()));
  });
  const count = await f.db.transaction(async (q) => {
    await q.query("SET LOCAL ROLE evidence_runtime");
    await q.query(
      "SELECT set_config('evidence.tenant_id',$1,true),set_config('evidence.project_id',$2,true)",
      [owner.tenantId, owner.projectId],
    );
    return (
      await q.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM public.evidence_outbox WHERE topic='cost.allocated'",
      )
    ).rows[0]!.count;
  });
  assert.equal(count, 1);
});

test("failure after allocation outbox insertion rolls back record, audit and command acknowledgement atomically", async (t) => {
  const f = await settled(t);
  let fail = true,
    hit = false;
  const db = {
    ...f.db,
    transaction: <T>(fn: Parameters<typeof f.db.transaction<T>>[0]) =>
      f.db.transaction((q) =>
        fn({
          query: async <R>(sql: string, v?: unknown[]) => {
            const result = await q.query<R>(sql, v);
            if (
              fail &&
              sql.includes("INSERT INTO public.evidence_outbox") &&
              v?.includes("cost.allocated")
            ) {
              hit = true;
              fail = false;
              throw Error("fixture rollback");
            }
            return result;
          },
        }),
      ),
  };
  const store = new BudgetStore(
    db,
    {
      tenantId: owner.tenantId,
      projectId: owner.projectId,
      managerIds: ["owner"],
    },
    verifier,
  );
  await assert.rejects(
    store.allocate(owner, f.input, "rollback"),
    /fixture rollback/,
  );
  assert.equal(hit, true);
  assert.equal(
    await f.store.loadAllocation(owner, "budget", "reservation"),
    null,
  );
  await scoped(f.db, owner, async (tx) =>
    assert.equal(
      (await tx.audits()).filter((a) => a.type === "cost.allocated").length,
      0,
    ),
  );
  assert.equal((await store.allocate(owner, f.input, "rollback")).revision, 1);
  assert.deepEqual(await f.store.load(owner, "budget"), f.settled);
});

test("captured allocation inputs/context/configuration survive awaits and returned snapshots cannot mutate persisted data", async (t) => {
  const f = await settled(t),
    input = structuredClone(f.input),
    c = structuredClone(owner),
    configuration = {
      tenantId: owner.tenantId,
      projectId: owner.projectId,
      managerIds: ["owner"],
    };
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      entered = r;
    });
  const db = {
    ...f.db,
    transaction: async <T>(fn: Parameters<typeof f.db.transaction<T>>[0]) => {
      entered();
      await gate;
      return f.db.transaction(fn);
    },
  };
  const store = new BudgetStore(db, configuration, verifier),
    pending = store.allocate(c, input, "capture");
  await started;
  input.lines[0]!.units = 100;
  (c.actor as unknown as { roles: string[] }).roles = [];
  configuration.managerIds.length = 0;
  release();
  const row = await pending;
  assert.deepEqual(row.value.lines, lines);
  (row.value.lines as { units: number }[])[0]!.units = 999;
  assert.deepEqual(
    (await f.store.loadAllocation(owner, "budget", "reservation"))!.value.lines,
    lines,
  );
});

test("exact historical source edition is loaded and phantom pre-settlement references/foreign scope/extra metadata are rejected", async (t) => {
  const good = await settled(t),
    valid = await good.store.allocate(owner, good.input, "reference");
  for (const change of ["edition", "scope", "extra"]) {
    const f = await settled(t),
      value = structuredClone(valid.value);
    if (change === "edition")
      (value.source.budget as { revision: number }).revision = 1;
    if (change === "scope")
      (value.source as { projectId: string }).projectId = "foreign";
    if (change === "extra")
      (value as unknown as Record<string, unknown>).credential = "excluded";
    // Fixture-only corrupted row. No engine operation writes these profiles.
    await scoped(f.db, owner, (tx) =>
      tx.put("cost-allocation", valid.id, 0, value),
    );
    await assert.rejects(
      f.store.loadAllocation(owner, "budget", "reservation"),
    );
  }
});
