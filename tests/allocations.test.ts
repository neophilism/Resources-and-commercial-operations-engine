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

test("one immutable allocation per settled reservation survives concurrent managers/commands and exact historical replay after later budget revisions", async (t) => {
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
