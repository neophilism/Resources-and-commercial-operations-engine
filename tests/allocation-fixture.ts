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
export const owner: Context = {
  tenantId: "alpha",
  projectId: "study",
  actor: { id: "owner", kind: "human", roles: ["owner"] },
  purpose: "research",
  requestId: "r",
  now: "2026-01-01T00:00:00Z",
};
export const agent: Context = {
  ...owner,
  actor: { id: "worker", kind: "agent", roles: [] },
};
export const budget = {
  id: "budget",
  unit: "credits",
  limit: 100,
  operators: [
    { id: "owner", kind: "human" as const },
    { id: "worker", kind: "agent" as const },
  ],
};
export const reservation = {
  id: "reservation",
  units: 60,
  purpose: "research",
  expiresAt: "2026-01-01T00:01:00Z",
  effectKey: "effect-1",
};
export const receipt = {
  tenantId: "alpha",
  projectId: "study",
  kind: "provider-receipt",
  id: "verified",
  revision: 1,
};
export const verifier: ReceiptVerifier = {
  verify: async (check) =>
    check.receipt.id === "verified" &&
    check.effectKey === "effect-1" &&
    check.unit === "credits" &&
    check.actualUnits >= 0,
};
export async function setup(t: test.TestContext, verify = verifier) {
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
export async function committed(store: BudgetStore) {
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
