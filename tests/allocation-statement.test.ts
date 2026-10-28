import test from "node:test";
import assert from "node:assert/strict";
import { scoped, verifyAudit } from "@accountability/evidence/database";
import { BudgetStore } from "../src/store.ts";
import { digest } from "../src/contracts.ts";
import {
  setup,
  committed,
  owner,
  agent,
  receipt,
  verifier,
} from "./allocation-fixture.ts";
async function allocated(t: test.TestContext) {
  const f = await setup(t),
    ready = await committed(f.store);
  const settled = await f.store.execute(
    agent,
    "budget",
    ready.revision,
    { type: "settle", reservationId: "reservation", actualUnits: 45, receipt },
    "settle",
  );
  const original = await f.store.allocate(
    owner,
    {
      budgetId: "budget",
      reservationId: "reservation",
      expectedBudgetRevision: settled.revision,
      lines: [{ projectId: "label-a", contributorId: "label-a", units: 45 }],
    },
    "allocate",
  );
  return { ...f, settled, original };
}
test("accounting statement joins current effective cells with exact original correction and observed budget editions", async (t) => {
  const f = await allocated(t),
    first = await f.store.loadAllocationStatement(
      owner,
      "budget",
      "reservation",
    );
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.correction, null);
  assert.deepEqual(first.lines, f.original.value.lines);
  assert.deepEqual(first.source, f.original.value.source);
  assert.equal(first.allocation.id, f.original.id);
  assert.equal(first.allocation.revision, 1);
  const input = {
    budgetId: "budget",
    reservationId: "reservation",
    expectedCorrectionRevision: 0,
    lines: [{ projectId: "label-b", contributorId: "label-b", units: 45 }],
    reason: "Fictional accounting label correction",
  };
  const correction = await f.store.correctAllocation(owner, input, "correct");
  const next = await f.store.loadAllocationStatement(
    owner,
    "budget",
    "reservation",
  );
  assert.equal(next.correction!.id, correction.id);
  assert.equal(next.correction!.revision, 1);
  assert.deepEqual(next.lines, input.lines);
  await f.store.correctAllocation(
    owner,
    { ...input, expectedCorrectionRevision: 1, lines: f.original.value.lines },
    "second",
  );
  // Historical cached correction acknowledgement cannot choose the statement's effective edition.
  assert.equal(
    (await f.store.correctAllocation(owner, input, "correct")).revision,
    1,
  );
  const latest = await f.store.loadAllocationStatement(
    owner,
    "budget",
    "reservation",
  );
  assert.equal(latest.correction!.revision, 2);
  assert.deepEqual(latest.lines, f.original.value.lines);
  assert.deepEqual(await f.store.load(owner, "budget"), f.settled);
  assert.deepEqual(
    await f.store.loadAllocation(owner, "budget", "reservation"),
    f.original,
  );
  (latest.lines[0] as { units: number }).units = 999;
  assert.deepEqual(
    (await f.store.loadAllocationStatement(owner, "budget", "reservation"))
      .lines,
    f.original.value.lines,
  );
  await scoped(f.db, owner, async (tx) =>
    assert.ok(verifyAudit(await tx.audits())),
  );
});
test("statement refuses missing allocation revoked current authority foreign purpose and contradictory source", async (t) => {
  const f = await allocated(t);
  for (const c of [
    { ...owner, actor: { ...owner.actor, roles: [] } },
    agent,
    { ...owner, purpose: "other" },
    { ...owner, tenantId: "other" },
    { ...owner, projectId: "other" },
  ])
    await assert.rejects(
      f.store.loadAllocationStatement(c, "budget", "reservation"),
    );
  const g = await setup(t);
  await assert.rejects(
    g.store.loadAllocationStatement(owner, "budget", "reservation"),
  );
  await scoped(f.db, owner, (tx) =>
    tx.put(
      "budget",
      digest({ kind: "budget", id: "budget" }),
      f.settled.revision,
      { ...f.settled.state, unit: "other" },
    ),
  );
  await assert.rejects(
    f.store.loadAllocationStatement(owner, "budget", "reservation"),
    { code: "allocation_source_changed" },
  );
});
test("statement acquires actual project FOR UPDATE before any source reads and rejects corrupt latest predecessor", async (t) => {
  const f = await allocated(t);
  const queries: string[] = [];
  const db = {
    ...f.db,
    transaction: <T>(fn: Parameters<typeof f.db.transaction<T>>[0]) =>
      f.db.transaction((q) =>
        fn({
          query: async <R>(sql: string, v?: unknown[]) => {
            queries.push(sql);
            return q.query<R>(sql, v);
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
  await store.loadAllocationStatement(owner, "budget", "reservation");
  const lock = queries.findIndex((s) => s.includes("FOR UPDATE")),
    read = queries.findIndex((s) => s.includes("FROM public.evidence_record"));
  assert.ok(
    lock >= 0 && read > lock,
    "Actual owning SQL lock must precede record reads",
  );
  const id = digest({
    kind: "cost-allocation-correction",
    allocationId: f.original.id,
  });
  await scoped(f.db, owner, (tx) =>
    tx.put("cost-allocation-correction", id, 0, {
      tenantId: owner.tenantId,
      projectId: owner.projectId,
      allocation: {
        ...owner,
        kind: "cost-allocation",
        id: f.original.id,
        revision: 1,
      },
      previous: { kind: "wrong" },
      lines: f.original.value.lines,
      reason: "bad",
      recordedAt: owner.now,
      recordedBy: owner.actor.id,
    }),
  );
  await assert.rejects(
    store.loadAllocationStatement(owner, "budget", "reservation"),
    { code: "invalid_correction" },
  );
});
