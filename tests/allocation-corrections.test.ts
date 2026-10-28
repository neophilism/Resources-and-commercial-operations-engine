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
