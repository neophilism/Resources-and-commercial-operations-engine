import test from "node:test";
import assert from "node:assert/strict";
import { scoped, verifyAudit } from "@accountability/evidence/database";
import {
  setup,
  committed,
  owner,
  agent,
  receipt,
} from "./allocation-fixture.ts";
import { BudgetStore } from "../src/store.ts";
import { digest } from "../src/contracts.ts";
import { verifier } from "./allocation-fixture.ts";
import type { AllocationCorrectionInput } from "../src/store.ts";
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
      lines: [{ projectId: "a", contributorId: "a", units: 45 }],
    },
    "original",
  );
  const input: AllocationCorrectionInput = {
    budgetId: "budget",
    reservationId: "reservation",
    expectedCorrectionRevision: 0,
    lines: [
      { projectId: "a", contributorId: "a", units: 20 },
      { projectId: "b", contributorId: "b", units: 25 },
    ],
    reason: "Fictional allocation label correction",
  };
  return { ...f, settled, original, input };
}
test("corrections retain exact original and predecessor editions with balanced unchanged budget history", async (t) => {
  const f = await allocated(t);
  assert.equal(
    await f.store.loadAllocationCorrection(owner, "budget", "reservation"),
    null,
  );
  const first = await f.store.correctAllocation(owner, f.input, "first"),
    second = await f.store.correctAllocation(
      owner,
      {
        ...f.input,
        expectedCorrectionRevision: 1,
        lines: [{ projectId: "c", contributorId: "c", units: 45 }],
      },
      "second",
    );
  assert.equal(first.revision, 1);
  assert.equal(first.value.previous, null);
  assert.equal(first.value.allocation.id, f.original.id);
  assert.equal(first.value.allocation.revision, 1);
  assert.equal(second.revision, 2);
  assert.equal(second.value.previous!.id, first.id);
  assert.equal(second.value.previous!.revision, 1);
  assert.deepEqual(
    await f.store.loadAllocationCorrection(owner, "budget", "reservation"),
    second,
  );
  assert.deepEqual(
    await f.store.loadAllocationCorrection(owner, "budget", "reservation", 1),
    first,
  );
  assert.deepEqual(
    await f.store.loadAllocation(owner, "budget", "reservation"),
    f.original,
  );
  assert.deepEqual(await f.store.load(owner, "budget"), f.settled);
  assert.deepEqual(
    await f.store.correctAllocation(owner, f.input, "first"),
    first,
  );
  await scoped(f.db, owner, async (tx) => {
    assert.equal((await tx.list("cost-allocation-correction")).length, 1);
    assert.equal(
      (await tx.audits()).filter((a) => a.type === "cost.allocation.corrected")
        .length,
      2,
    );
    assert.ok(verifyAudit(await tx.audits()));
  });
});
test("competing corrections at one edition cannot branch or replace original; changed replay conflicts", async (t) => {
  const f = await allocated(t),
    other = {
      ...f.input,
      lines: [{ projectId: "d", contributorId: "d", units: 45 }],
    };
  const results = await Promise.allSettled([
    f.store.correctAllocation(owner, f.input, "one"),
    f.store.correctAllocation(owner, other, "two"),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    (results.find((x) => x.status === "rejected") as PromiseRejectedResult)
      .reason.code,
    "revision_conflict",
  );
  const key = results[0]!.status === "fulfilled" ? "one" : "two",
    changed = results[0]!.status === "fulfilled" ? other : f.input;
  await assert.rejects(f.store.correctAllocation(owner, changed, key), {
    code: "idempotency_conflict",
  });
  assert.equal(
    (await f.store.loadAllocationCorrection(owner, "budget", "reservation"))!
      .revision,
    1,
  );
});
test("correction requires original, exact fields, safe balanced bounded changed lines and finite editions", async (t) => {
  const f = await allocated(t);
  for (const input of [
    { ...f.input, extra: "excluded" },
    { ...f.input, reason: "" },
    { ...f.input, reason: "x".repeat(1001) },
    { ...f.input, expectedCorrectionRevision: -1 },
    { ...f.input, expectedCorrectionRevision: 64 },
    { ...f.input, lines: f.original.value.lines },
    { ...f.input, lines: [] },
    { ...f.input, lines: [{ projectId: "a", contributorId: "a", units: 44 }] },
    { ...f.input, lines: [{ projectId: "a", contributorId: "a", units: -1 }] },
    { ...f.input, lines: [f.input.lines[0]!, f.input.lines[0]!] },
    {
      ...f.input,
      lines: Array.from({ length: 257 }, (_, i) => ({
        projectId: "a",
        contributorId: String(i),
        units: 0,
      })),
    },
  ] as AllocationCorrectionInput[])
    await assert.rejects(f.store.correctAllocation(owner, input, "bad"));
  for (const revision of [0, -1, 65, NaN, 1.5])
    await assert.rejects(
      f.store.loadAllocationCorrection(
        owner,
        "budget",
        "reservation",
        revision,
      ),
    );
  assert.equal(
    await f.store.loadAllocationCorrection(owner, "budget", "reservation"),
    null,
  );
  const none = await setup(t),
    r = await committed(none.store);
  await none.store.execute(
    agent,
    "budget",
    r.revision,
    { type: "settle", reservationId: "reservation", actualUnits: 45, receipt },
    "settle",
  );
  await assert.rejects(
    none.store.correctAllocation(owner, f.input, "missing"),
    { code: "allocation_required" },
  );
});

test("correction reads and historical replay require current manager/operator kind purpose scope and intact original source", async (t) => {
  const f = await allocated(t);
  await f.store.correctAllocation(owner, f.input, "auth");
  for (const c of [
    { ...owner, actor: { ...owner.actor, roles: [] } },
    { ...owner, actor: { ...owner.actor, kind: "service" as const } },
    { ...owner, actor: { ...owner.actor, id: "unlisted" } },
    { ...owner, purpose: "other" },
    { ...owner, projectId: "other" },
    { ...owner, tenantId: "other" },
  ]) {
    await assert.rejects(f.store.correctAllocation(c, f.input, "auth"));
    await assert.rejects(
      f.store.loadAllocationCorrection(c, "budget", "reservation"),
    );
    await assert.rejects(
      f.store.loadAllocationCorrection(c, "budget", "reservation", 1),
    );
  }
  // Fixture-only current policy change while preserving principal ID but changing kind.
  await scoped(f.db, owner, async (tx) => {
    const key = digest({ kind: "budget", id: "budget" }),
      row = await tx.get<any>("budget", key);
    await tx.put("budget", key, row!.revision, {
      ...row!.value,
      operators: [{ id: "owner", kind: "service" }, agent.actor],
    });
  });
  await assert.rejects(f.store.correctAllocation(owner, f.input, "auth"), {
    code: "operator_denied",
  });
  await assert.rejects(
    f.store.loadAllocationCorrection(owner, "budget", "reservation"),
    { code: "operator_denied" },
  );
});

test("lost correction COMMIT acknowledgement replays through fresh store without duplicate history audit or outbox", async (t) => {
  const f = await allocated(t);
  let wrote = false,
    lost = false;
  const db = {
    ...f.db,
    transaction: async <T>(fn: Parameters<typeof f.db.transaction<T>>[0]) => {
      const result = await f.db.transaction((q) =>
        fn({
          query: async <R>(sql: string, v?: unknown[]) => {
            const r = await q.query<R>(sql, v);
            if (
              sql.includes("INSERT INTO public.evidence_outbox") &&
              v?.includes("cost.allocation.corrected")
            )
              wrote = true;
            return r;
          },
        }),
      );
      if (wrote && !lost) {
        lost = true;
        throw Error("lost correction acknowledgement");
      }
      return result;
    },
  };
  const policy = {
    tenantId: owner.tenantId,
    projectId: owner.projectId,
    managerIds: ["owner"],
  };
  const store = new BudgetStore(db, policy, verifier);
  await assert.rejects(
    store.correctAllocation(owner, f.input, "lost"),
    /lost correction/,
  );
  assert.equal(lost, true);
  const fresh = new BudgetStore(f.db, policy, verifier),
    first = await fresh.correctAllocation(owner, f.input, "lost");
  assert.equal(first.revision, 1);
  const later = await fresh.correctAllocation(
    owner,
    {
      ...f.input,
      expectedCorrectionRevision: 1,
      lines: f.original.value.lines,
    },
    "later",
  );
  assert.equal(later.revision, 2);
  assert.deepEqual(
    await fresh.correctAllocation(owner, f.input, "lost"),
    first,
  );
  await scoped(f.db, owner, async (tx) => {
    assert.equal(
      (await tx.audits()).filter((a) => a.type === "cost.allocation.corrected")
        .length,
      2,
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
        "SELECT count(*)::int AS count FROM public.evidence_outbox WHERE topic='cost.allocation.corrected'",
      )
    ).rows[0]!.count;
  });
  assert.equal(count, 2);
  assert.deepEqual(await fresh.load(owner, "budget"), f.settled);
});

test("post-outbox correction failure rolls back revision audit outbox and acknowledgement together", async (t) => {
  const f = await allocated(t);
  let fail = true,
    hit = false;
  const db = {
    ...f.db,
    transaction: <T>(fn: Parameters<typeof f.db.transaction<T>>[0]) =>
      f.db.transaction((q) =>
        fn({
          query: async <R>(sql: string, v?: unknown[]) => {
            const r = await q.query<R>(sql, v);
            if (
              fail &&
              sql.includes("INSERT INTO public.evidence_outbox") &&
              v?.includes("cost.allocation.corrected")
            ) {
              hit = true;
              fail = false;
              throw Error("fixture correction rollback");
            }
            return r;
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
    store.correctAllocation(owner, f.input, "rollback"),
    /fixture correction rollback/,
  );
  assert.equal(hit, true);
  assert.equal(
    await f.store.loadAllocationCorrection(owner, "budget", "reservation"),
    null,
  );
  await scoped(f.db, owner, async (tx) =>
    assert.equal(
      (await tx.audits()).filter((a) => a.type === "cost.allocation.corrected")
        .length,
      0,
    ),
  );
  assert.equal(
    (await store.correctAllocation(owner, f.input, "rollback")).revision,
    1,
  );
  assert.deepEqual(
    await f.store.loadAllocation(owner, "budget", "reservation"),
    f.original,
  );
});

test("correction captures context inputs configuration before await and returns detached immutable history", async (t) => {
  const f = await allocated(t),
    input = structuredClone(f.input),
    c = structuredClone(owner),
    policy = {
      tenantId: owner.tenantId,
      projectId: owner.projectId,
      managerIds: ["owner"],
    };
  let release!: () => void, enter!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    entered = new Promise<void>((r) => (enter = r));
  const db = {
    ...f.db,
    transaction: async <T>(fn: Parameters<typeof f.db.transaction<T>>[0]) => {
      enter();
      await gate;
      return f.db.transaction(fn);
    },
  };
  const store = new BudgetStore(db, policy, verifier),
    pending = store.correctAllocation(c, input, "capture");
  await entered;
  (input.lines[0] as { units: number }).units = 999;
  (input as { reason: string }).reason = "mutated";
  (c.actor as unknown as { roles: string[] }).roles = [];
  policy.managerIds.length = 0;
  release();
  const row = await pending;
  assert.deepEqual(row.value.lines, f.input.lines);
  assert.equal(row.value.reason, f.input.reason);
  (row.value.lines[0] as { units: number }).units = 999;
  assert.deepEqual(
    (await f.store.loadAllocationCorrection(owner, "budget", "reservation"))!
      .value.lines,
    f.input.lines,
  );
});

test("correction validation rejects corrupt source predecessor fields and previous history on read append and cached replay", async (t) => {
  const f = await allocated(t),
    first = await f.store.correctAllocation(owner, f.input, "first");
  const second = await f.store.correctAllocation(
    owner,
    {
      ...f.input,
      expectedCorrectionRevision: 1,
      lines: f.original.value.lines,
    },
    "second",
  );
  for (const change of [
    "scope",
    "root",
    "previous",
    "extra",
    "unbalanced",
    "time",
    "reason",
  ]) {
    const value = structuredClone(second.value) as any;
    if (change === "scope") value.projectId = "foreign";
    if (change === "root") value.allocation.revision = 2;
    if (change === "previous") value.previous.revision = 2;
    if (change === "extra") value.credential = "excluded";
    if (change === "unbalanced") value.lines[0].units = 44;
    if (change === "time") value.recordedAt = "bad";
    if (change === "reason") value.reason = " ";
    // Direct corrupt-row fixture ONLY; no engine editing/deletion route.
    const corrupt = { ...second, value };
    const db = {
      ...f.db,
      transaction: <T>(fn: Parameters<typeof f.db.transaction<T>>[0]) =>
        f.db.transaction((q) =>
          fn({
            query: async <R>(sql: string, v?: unknown[]) => {
              const r = await q.query<R>(sql, v);
              if (
                sql.includes("FROM public.evidence_record") &&
                v?.includes(first.id)
              )
                for (const raw of r.rows as any[])
                  if (raw.revision === 2) raw.value = corrupt.value;
              return r;
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
      store.loadAllocationCorrection(owner, "budget", "reservation"),
      change,
    );
    await assert.rejects(
      store.correctAllocation(
        owner,
        { ...f.input, expectedCorrectionRevision: 2 },
        "bad-" + change,
      ),
      change,
    );
    await assert.rejects(
      store.correctAllocation(
        owner,
        {
          ...f.input,
          expectedCorrectionRevision: 1,
          lines: f.original.value.lines,
        },
        "second",
      ),
      change,
    );
  }
  // Independently seed a malformed first edition and legitimate-looking successor: history must be followed.
  const other = await allocated(t),
    root = {
      ...first.value,
      allocation: { ...first.value.allocation, id: "wrong" },
    };
  await scoped(other.db, owner, async (tx) => {
    await tx.put("cost-allocation-correction", first.id, 0, root);
    await tx.put("cost-allocation-correction", first.id, 1, second.value);
  });
  await assert.rejects(
    other.store.loadAllocationCorrection(owner, "budget", "reservation"),
    { code: "invalid_correction" },
  );
});

test("64 correction editions retain history and cap safely with exact historical replay still permitted", async (t) => {
  const f = await allocated(t);
  let row;
  for (let revision = 0; revision < 64; revision++) {
    row = await f.store.correctAllocation(
      owner,
      {
        ...f.input,
        expectedCorrectionRevision: revision,
        lines: [
          {
            projectId: "edition-" + revision,
            contributorId: "label",
            units: 45,
          },
        ],
      },
      "edition-" + revision,
    );
    assert.equal(row.revision, revision + 1);
  }
  assert.deepEqual(
    await f.store.loadAllocationCorrection(owner, "budget", "reservation"),
    row,
  );
  await assert.rejects(
    f.store.correctAllocation(
      owner,
      { ...f.input, expectedCorrectionRevision: 64 },
      "overflow",
    ),
    { code: "invalid_revision" },
  );
  const replay = await f.store.correctAllocation(
    owner,
    {
      ...f.input,
      lines: [{ projectId: "edition-0", contributorId: "label", units: 45 }],
    },
    "edition-0",
  );
  assert.equal(replay.revision, 1);
  assert.equal(replay.value.previous, null);
  assert.deepEqual(await f.store.load(owner, "budget"), f.settled);
  await scoped(f.db, owner, async (tx) =>
    assert.equal(
      (await tx.audits()).filter((a) => a.type === "cost.allocation.corrected")
        .length,
      64,
    ),
  );
});

test("correction acknowledgement remains historical after later budget revisions but current source changes deny replay and reads", async (t) => {
  const f = await allocated(t),
    first = await f.store.correctAllocation(owner, f.input, "first");
  const later = await f.store.execute(
    owner,
    "budget",
    f.settled.revision,
    {
      type: "reserve",
      input: {
        id: "later",
        units: 1,
        purpose: owner.purpose,
        expiresAt: "2026-01-01T00:01:00Z",
        effectKey: "later",
      },
    },
    "later",
  );
  assert.deepEqual(
    await f.store.correctAllocation(owner, f.input, "first"),
    first,
  );
  assert.deepEqual(
    await f.store.loadAllocationCorrection(owner, "budget", "reservation"),
    first,
  );
  assert.deepEqual(
    await f.store.loadAllocation(owner, "budget", "reservation"),
    f.original,
  );
  // Fixture-only contradictory source change; correction cannot conceal/rewrite it.
  await scoped(f.db, owner, (tx) =>
    tx.put("budget", digest({ kind: "budget", id: "budget" }), later.revision, {
      ...later.state,
      unit: "other-unit",
    }),
  );
  await assert.rejects(f.store.correctAllocation(owner, f.input, "first"), {
    code: "allocation_source_changed",
  });
  await assert.rejects(
    f.store.loadAllocationCorrection(owner, "budget", "reservation"),
    { code: "allocation_source_changed" },
  );
});
