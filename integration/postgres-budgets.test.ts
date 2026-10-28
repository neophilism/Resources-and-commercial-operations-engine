import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  postgresDatabase,
  scoped,
  verifyAudit,
} from "@accountability/evidence/database";
import type { Database } from "@accountability/evidence/database";
import { BudgetStore } from "../src/store.ts";
import type { BudgetState } from "../src/index.ts";
import { budgetBalance } from "../src/index.ts";
import { digest } from "../src/contracts.ts";
import type { Context } from "../src/contracts.ts";
// Intentionally refuses arbitrary or persistent database targets. CI owns this empty fixture only.
const supplied = process.env.RCO_TEST_ADMIN_URL;
assert.ok(
  process.env.RCO_TEST_DISPOSABLE_POSTGRES === "1" && supplied,
  "Explicit disposable PostgreSQL fixture configuration required",
);
const url = new URL(supplied);
assert.ok(
  ["postgres:", "postgresql:"].includes(url.protocol) &&
    ["localhost", "127.0.0.1"].includes(url.hostname) &&
    url.pathname === "/resources_ci" &&
    url.username === "postgres" &&
    !url.search &&
    !url.hash,
  "Only the designated empty loopback fixture is accepted",
);
const admin = postgresDatabase(url.toString());
before(async () => {
  await admin.transaction(async (q) => {
    assert.equal(
      (
        await q.query<{ fresh: boolean }>(
          "SELECT to_regclass('public.evidence_project') IS NULL AS fresh",
        )
      ).rows[0]!.fresh,
      true,
      "Fixture must be empty; never reset a database here",
    );
    const migration = await readFile(
      new URL(
        "../migrations/001_foundation.sql",
        import.meta.resolve("@accountability/evidence/database"),
      ),
      "utf8",
    );
    assert.equal(migration.match(/^BEGIN;$/gm)?.length, 1);
    assert.equal(migration.match(/^COMMIT;$/gm)?.length, 1);
    // The SDK transaction owns BEGIN/COMMIT; every actual migration statement is unchanged.
    await q.query(migration.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, ""));
    await q.query(
      "CREATE ROLE resource_network_login LOGIN PASSWORD 'fixture-runtime-only' NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; GRANT evidence_runtime TO resource_network_login",
    );
  });
});
after(() => admin.close());

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
async function fixture(t: test.TestContext, id: string) {
  const owner: Context = {
    tenantId: "fiction",
    projectId: id,
    actor: { id: "owner", kind: "human", roles: ["owner"] },
    purpose: "review",
    requestId: "fixture",
    now: "2026-01-01T00:00:00Z",
  };
  const worker: Context = {
    ...owner,
    actor: { id: "worker", kind: "agent", roles: [] },
  };
  const policy = {
    tenantId: owner.tenantId,
    projectId: id,
    managerIds: ["owner"],
  };
  const verifier = { verify: async () => true }; // Controlled port, no provider attestation.
  function connect(label: string) {
    const u = new URL(url);
    u.username = "resource_network_login";
    u.password = "fixture-runtime-only";
    u.searchParams.set("application_name", id + "-" + label);
    const db = postgresDatabase(u.toString());
    t.after(() => db.close());
    return db;
  }
  const a = connect("a"),
    b = connect("b");
  const pids = await Promise.all(
    [a, b].map((db) =>
      db.transaction((q) =>
        q.query<{ pid: number; login: string }>(
          "SELECT pg_backend_pid() AS pid, session_user AS login",
        ),
      ),
    ),
  );
  assert.notEqual(pids[0]!.rows[0]!.pid, pids[1]!.rows[0]!.pid);
  assert.ok(pids.every((p) => p.rows[0]!.login === "resource_network_login"));
  const sa = new BudgetStore(a, policy, verifier),
    sb = new BudgetStore(b, policy, verifier);
  await sa.create(
    owner,
    {
      id: "budget",
      unit: "fixture-credits",
      limit: 100,
      operators: [owner.actor, worker.actor],
    },
    "create",
  );
  const reservation = {
    id: "one",
    units: 60,
    purpose: owner.purpose,
    expiresAt: "2026-01-01T00:01:00Z",
    effectKey: "fictional-effect",
  };
  async function committed() {
    await sa.execute(
      worker,
      "budget",
      1,
      { type: "reserve", input: reservation },
      "reserve",
    );
    return sa.execute(
      worker,
      "budget",
      2,
      { type: "commit", reservationId: "one" },
      "commit",
    );
  }
  return {
    owner,
    worker,
    policy,
    verifier,
    a,
    b,
    sa,
    sb,
    reservation,
    committed,
    connect,
  };
}
test(
  "independent PostgreSQL reservations cannot overspend the same revision",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, "network-reserve");
    const results = await Promise.allSettled([
      f.sa.execute(
        f.worker,
        "budget",
        1,
        { type: "reserve", input: f.reservation },
        "a",
      ),
      f.sb.execute(
        f.worker,
        "budget",
        1,
        {
          type: "reserve",
          input: { ...f.reservation, id: "two", effectKey: "other" },
        },
        "b",
      ),
    ]);
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
    const denied = results.find(
      (x) => x.status === "rejected",
    ) as PromiseRejectedResult;
    assert.equal(denied.reason.code, "revision_conflict");
    assert.equal(
      budgetBalance((await f.sb.load(f.worker, "budget")).state).available,
      40,
    );
    await scoped(f.b, f.owner, async (tx) =>
      assert.ok(verifyAudit(await tx.audits())),
    );
  },
);
test(
  "independent PostgreSQL sessions consume a committed effect only once",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, "network-consume");
    await f.committed();
    const results = await Promise.allSettled([
      f.sa.consumeEffect(f.worker, "budget", 3, "one"),
      f.sb.consumeEffect(f.worker, "budget", 3, "one"),
    ]);
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(results.filter((x) => x.status === "rejected").length, 1);
    const current = await f.sb.load(f.worker, "budget");
    assert.equal(current.revision, 4);
    assert.equal(current.state.reservations[0]!.status, "uncertain");
    assert.equal(budgetBalance(current.state).reserved, 60);
    await assert.rejects(f.sa.consumeEffect(f.worker, "budget", 4, "one"), {
      code: "effect_consumed",
    });
    await scoped(f.a, f.owner, async (tx) =>
      assert.equal(
        (await tx.audits()).filter((e) => e.type === "budget.effect_consumed")
          .length,
        1,
      ),
    );
  },
);
test(
  "lost PostgreSQL COMMIT acknowledgement survives a fresh pool and never reissues effect authority",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, "network-lost-ack");
    await f.committed();
    let lost = false;
    const db: Database = {
      transaction: async (fn) => {
        const value = await f.a.transaction(fn);
        if (!lost) {
          lost = true;
          throw Error("fixture lost acknowledgement");
        }
        return value;
      },
      close: async () => {},
    };
    const uncertain = new BudgetStore(db, f.policy, f.verifier);
    await assert.rejects(uncertain.consumeEffect(f.worker, "budget", 3, "one"));
    assert.equal(lost, true);
    const fresh = new BudgetStore(f.connect("fresh"), f.policy, f.verifier);
    const current = await fresh.load(f.worker, "budget");
    assert.equal(current.revision, 4);
    await assert.rejects(fresh.consumeEffect(f.worker, "budget", 4, "one"), {
      code: "effect_consumed",
    });
    assert.equal(budgetBalance(current.state).reserved, 60);
    // Historical command replay is metadata, never a new effect permit.
    const replay = await fresh.execute(
      f.worker,
      "budget",
      2,
      { type: "commit", reservationId: "one" },
      "commit",
    );
    assert.equal(replay.revision, 3);
    assert.equal((await fresh.load(f.worker, "budget")).revision, 4);
  },
);
test(
  "cached command authorization reloads membership after an observed PostgreSQL project lock wait",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, "network-revocation");
    const command = { type: "reserve" as const, input: f.reservation };
    await f.sa.execute(f.worker, "budget", 1, command, "reserve");
    const locked = gate(),
      release = gate();
    const hold = scoped(f.a, f.owner, async (tx) => {
      await tx.audit("fixture.policy-lock", { fixture: true });
      const row = await tx.get<BudgetState>(
        "budget",
        digest({ kind: "budget", id: "budget" }),
      );
      // Fixture-only trusted policy write; no membership administration API is claimed.
      await tx.put("budget", row!.id, row!.revision, {
        ...row!.value,
        operators: [f.owner.actor],
      });
      locked.resolve();
      await release.promise;
    });
    let replay: Promise<unknown> | undefined;
    try {
      await Promise.race([locked.promise, hold]);
      replay = f.sb.execute(f.worker, "budget", 1, command, "reserve");
      const result = replay.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        const state = await admin.transaction((q) =>
          q.query<{ blocked: boolean }>(
            "SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0) AS blocked",
            ["network-revocation-b"],
          ),
        );
        if (state.rows[0]!.blocked) {
          blocked = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(blocked, true, "Real blocked backend must be observed");
      release.resolve();
      await hold;
      const outcome = await result;
      assert.ok("error" in outcome);
      assert.equal((outcome.error as { code: string }).code, "operator_denied");
      assert.equal((await f.sa.load(f.owner, "budget")).revision, 3);
    } finally {
      release.resolve();
      await hold;
      await replay?.catch(() => {});
    }
  },
);

test(
  "independent PostgreSQL allocation waits for the winning public transaction and retains one immutable record/history/outbox",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, "network-allocation");
    await f.committed();
    const receipt = {
      tenantId: f.owner.tenantId,
      projectId: f.owner.projectId,
      kind: "fictional-charge-receipt",
      id: "one",
      revision: 1,
    };
    const settled = await f.sa.execute(
      f.worker,
      "budget",
      3,
      { type: "settle", reservationId: "one", actualUnits: 45, receipt },
      "settle",
    );
    const input = {
      budgetId: "budget",
      expectedBudgetRevision: settled.revision,
      reservationId: "one",
      lines: [
        { projectId: "label-a", contributorId: "contributor-a", units: 45 },
      ],
    };
    const entered = gate(),
      release = gate();
    const db: Database = {
      ...f.a,
      transaction: (fn) =>
        f.a.transaction(async (q) => {
          const value = await fn(q);
          entered.resolve();
          await release.promise;
          return value;
        }),
    };
    const store = new BudgetStore(db, f.policy, f.verifier);
    const first = store.allocate(f.owner, input, "first");
    const firstResult = first.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let second: ReturnType<BudgetStore["allocate"]> | undefined;
    try {
      await Promise.race([
        entered.promise,
        first.then(() => {
          throw Error("Winning transaction did not hold");
        }),
      ]);
      second = f.sb.allocate(
        f.owner,
        {
          ...input,
          lines: [
            { projectId: "label-b", contributorId: "contributor-b", units: 45 },
          ],
        },
        "second",
      );
      const secondResult = second.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      let blocked = false;
      const until = Date.now() + 3000;
      while (Date.now() < until) {
        const state = await admin.transaction((q) =>
          q.query<{ blocked: boolean }>(
            "SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0) AS blocked",
            ["network-allocation-b"],
          ),
        );
        if (state.rows[0]!.blocked) {
          blocked = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(
        blocked,
        true,
        "Allocation contender must actually block before first COMMIT",
      );
      release.resolve();
      const winner = await firstResult;
      assert.ok("value" in winner);
      const denied = await secondResult;
      assert.ok("error" in denied);
      assert.equal(denied.error.code, "already_allocated");
      const fresh = new BudgetStore(f.connect("fresh"), f.policy, f.verifier);
      assert.deepEqual(
        await fresh.loadAllocation(f.owner, "budget", "one"),
        winner.value,
      );
      assert.deepEqual(
        await fresh.allocate(f.owner, input, "first"),
        winner.value,
      );
      assert.deepEqual(await fresh.load(f.owner, "budget"), settled);
      await scoped(f.b, f.owner, async (tx) => {
        assert.equal((await tx.list("cost-allocation")).length, 1);
        assert.equal(
          (await tx.audits()).filter((a) => a.type === "cost.allocated").length,
          1,
        );
        assert.ok(verifyAudit(await tx.audits()));
      });
      const count = await admin.transaction((q) =>
        q.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM public.evidence_outbox WHERE tenant_id=$1 AND project_id=$2 AND topic='cost.allocated'",
          [f.owner.tenantId, f.owner.projectId],
        ),
      );
      assert.equal(count.rows[0]!.count, 1);
    } finally {
      release.resolve();
      await first.catch(() => {});
      await second?.catch(() => {});
    }
  },
);

test(
  "PostgreSQL rejects privileged/lowered logins and confines real budget/allocation rows to the selected scope",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, "network-isolation"),
      other = await fixture(t, "network-isolation-other");
    async function allocate(x: typeof f) {
      await x.committed();
      const receipt = {
        tenantId: x.owner.tenantId,
        projectId: x.owner.projectId,
        kind: "fixture-receipt",
        id: "one",
        revision: 1,
      };
      await x.sa.execute(
        x.worker,
        "budget",
        3,
        { type: "settle", reservationId: "one", actualUnits: 45, receipt },
        "settle",
      );
      return x.sa.allocate(
        x.owner,
        {
          budgetId: "budget",
          expectedBudgetRevision: 4,
          reservationId: "one",
          lines: [
            { projectId: "label", contributorId: "contributor", units: 45 },
          ],
        },
        "allocate",
      );
    }
    const allocated = await allocate(f),
      foreign = await allocate(other);
    assert.equal(
      allocated.id,
      foreign.id,
      "Identical keys in distinct scopes exercise RLS rather than different IDs",
    );
    for (const db of [
      admin,
      {
        ...admin,
        transaction: <T>(fn: Parameters<Database["transaction"]>[0]) =>
          admin.transaction(async (q) => {
            await q.query("SET LOCAL ROLE evidence_runtime");
            return fn(q) as Promise<T>;
          }),
      } as Database,
    ]) {
      const unsafe = new BudgetStore(db, f.policy, f.verifier);
      await assert.rejects(unsafe.load(f.owner, "budget"), {
        code: "unsafe_database_role",
      });
      await assert.rejects(unsafe.loadAllocation(f.owner, "budget", "one"), {
        code: "unsafe_database_role",
      });
    }
    for (const sql of [
      "CREATE TABLE public.resource_escape(value integer)",
      "SET LOCAL ROLE postgres",
    ])
      await assert.rejects(
        f.a.transaction((q) => q.query(sql)),
        { code: "42501" },
      );
    // Authenticated LOGIN is NOINHERIT. Explicitly lower to the runtime role before RLS probes.
    const unscoped = await f.a.transaction(async (q) => {
      await q.query("SET LOCAL ROLE evidence_runtime");
      await q.query(
        "SELECT set_config('evidence.tenant_id','',true),set_config('evidence.project_id','',true)",
      );
      return q.query(
        "SELECT kind,id FROM public.evidence_record WHERE kind IN ('budget','cost-allocation')",
      );
    });
    assert.equal(unscoped.rows.length, 0);
    for (const x of [f, other])
      await scoped(x.a, x.owner, async (tx) => {
        const budgets = await tx.list<BudgetState>("budget"),
          allocations = await tx.list<{ projectId: string }>("cost-allocation");
        assert.equal(budgets.length, 1);
        assert.equal(budgets[0]!.value.projectId, x.owner.projectId);
        assert.equal(allocations.length, 1);
        assert.equal(allocations[0]!.value.projectId, x.owner.projectId);
        assert.equal(allocations[0]!.id, allocated.id);
        assert.ok(verifyAudit(await tx.audits()));
      });
    for (const context of [
      { ...f.owner, tenantId: "absent-tenant" },
      { ...f.owner, projectId: "absent-project" },
    ])
      await scoped(f.b, context, async (tx) => {
        assert.equal((await tx.list("budget")).length, 0);
        assert.equal((await tx.list("cost-allocation")).length, 0);
        assert.equal(await tx.get("cost-allocation", allocated.id), null);
      });
    // These selected-scope SQL settings are trusted-host inputs, not end-user authentication.
  },
);
