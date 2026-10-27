import { scoped } from "@accountability/evidence/database";
import type { Database, UnitOfWork } from "@accountability/evidence/database";
import {
  canonical,
  DomainError,
  digest,
  invariant,
  newId,
  requireScope,
  validateRef,
} from "./contracts.ts";
import type { Context, Json, Ref, Scope } from "./contracts.ts";
import {
  createBudget,
  budgetBalance,
  reserve,
  commitReservation,
  markUncertain,
  release,
  settle,
  recordOverage,
  expireReservations,
} from "./index.ts";
import type { BudgetState } from "./index.ts";
export type BudgetCommand =
  | { type: "reserve"; input: Parameters<typeof reserve>[2] }
  | { type: "commit"; reservationId: string }
  | { type: "uncertain"; reservationId: string }
  | { type: "release"; reservationId: string; proof: Ref | null }
  | { type: "settle"; reservationId: string; actualUnits: number; receipt: Ref }
  | {
      type: "overage";
      reservationId: string;
      actualUnits: number;
      receipt: Ref;
      reason: string;
    }
  | { type: "expire" };
export type ReceiptCheck = Scope & {
  budgetId: string;
  reservationId: string;
  effectKey: string;
  unit: string;
  outcome: "charge" | "no-charge";
  actualUnits: number;
  receipt: Ref;
};
export type ReceiptVerifier = {
  verify(check: ReceiptCheck, signal: AbortSignal): Promise<boolean>;
};
export type BudgetStorePolicy = Scope & {
  managerIds: readonly string[];
  receiptTimeoutMs?: number;
};
export type BudgetSnapshot = { revision: number; state: BudgetState };
export type EffectPermit = Scope & {
  id: string;
  budgetId: string;
  reservationId: string;
  effectKey: string;
  unit: string;
  maximumUnits: number;
  purpose: string;
  actorId: string;
  revision: number;
};
const json = (value: unknown): Json => JSON.parse(canonical(value)) as Json;
const idKey = (id: string) => digest({ kind: "budget", id });
export class BudgetStore {
  readonly #db: Database;
  readonly #policy: BudgetStorePolicy;
  readonly #verify: ReceiptVerifier["verify"];
  constructor(
    db: Database,
    policy: BudgetStorePolicy,
    verifier: ReceiptVerifier,
  ) {
    this.#db = db;
    this.#policy = structuredClone(policy);
    invariant(
      policy.receiptTimeoutMs === undefined ||
        (Number.isSafeInteger(policy.receiptTimeoutMs) &&
          policy.receiptTimeoutMs >= 10 &&
          policy.receiptTimeoutMs <= 30000),
      "invalid_timeout",
      "Receipt timeout must be10-30000milliseconds",
    );
    this.#verify = verifier.verify.bind(verifier);
  }
  #scope(c: Context): void {
    requireScope(c, this.#policy);
  }
  #manager(c: Context): void {
    this.#scope(c);
    invariant(
      c.actor.kind === "human" &&
        c.actor.roles.includes("owner") &&
        this.#policy.managerIds.includes(c.actor.id),
      "manager_required",
      "A listed human budget manager is required",
    );
  }
  #operator(c: Context, s: BudgetState): void {
    this.#scope(c);
    requireScope(c, s);
    invariant(
      s.operators.some((p) => p.id === c.actor.id && p.kind === c.actor.kind),
      "operator_denied",
      "Budget operator is not authorized",
    );
  }
  async #verifyReceipt(check: ReceiptCheck): Promise<boolean> {
    const controller = new AbortController();
    const timeoutMs = this.#policy.receiptTimeoutMs ?? 5000;
    const deadline = performance.now() + timeoutMs;
    const withinDeadline = () => {
      if (controller.signal.aborted || performance.now() >= deadline) {
        controller.abort();
        throw new DomainError(
          "receipt_timeout",
          "Receipt verification timed out",
        );
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(async () => {
          withinDeadline();
          let value: boolean;
          try {
            value = await this.#verify(
              structuredClone(check),
              controller.signal,
            );
          } catch {
            withinDeadline();
            throw new DomainError(
              "receipt_unavailable",
              "Receipt verifier could not complete",
            );
          }
          // A blocked event loop can postpone the timer beyond callback resolution.
          // Elapsed time and cancellation must still fence the result before SQL mutation.
          withinDeadline();
          return value === true;
        }),
        new Promise<boolean>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(
              new DomainError(
                "receipt_timeout",
                "Receipt verification timed out",
              ),
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }
  async #get(tx: UnitOfWork, c: Context, id: string): Promise<BudgetSnapshot> {
    const row = await tx.get<BudgetState>("budget", idKey(id));
    invariant(row, "not_found", "Budget not found");
    this.#operator(c, row.value);
    return { revision: row.revision, state: row.value };
  }
  async create(
    context: Context,
    input: Parameters<typeof createBudget>[1],
    commandId: string,
  ): Promise<BudgetSnapshot> {
    const c = structuredClone(context),
      captured = structuredClone(input);
    this.#manager(c);
    return scoped(this.#db, c, (tx) =>
      tx.idempotent(
        commandId,
        json({ type: "create-budget", input: captured }),
        async () => {
          const state = createBudget(c, captured);
          const row = await tx.put("budget", idKey(state.id), 0, state);
          return json({ revision: row.revision, state });
        },
      ),
    ) as Promise<unknown> as Promise<BudgetSnapshot>;
  }
  async load(context: Context, id: string): Promise<BudgetSnapshot> {
    const c = structuredClone(context);
    this.#scope(c);
    return scoped(this.#db, c, (tx) => this.#get(tx, c, id));
  }
  async execute(
    context: Context,
    budgetId: string,
    expectedRevision: number,
    command: BudgetCommand,
    commandId: string,
  ): Promise<BudgetSnapshot> {
    const c = structuredClone(context),
      input = structuredClone(command);
    this.#scope(c);
    return scoped(this.#db, c, (tx) =>
      tx.idempotent(
        commandId,
        json({ budgetId, expectedRevision, command: input }),
        async () => {
          const old = await this.#get(tx, c, budgetId);
          invariant(
            old.revision === expectedRevision,
            "revision_conflict",
            "Budget revision changed",
          );
          const state = old.state;
          if ("reservationId" in input) {
            const r = state.reservations.find(
              (r) => r.id === input.reservationId,
            );
            invariant(r, "not_found", "Reservation not found");
            if (input.type === "commit")
              invariant(
                c.purpose === r.purpose,
                "purpose_denied",
                "Effect purpose differs from reservation",
              );
            if (
              input.type === "settle" ||
              input.type === "overage" ||
              (input.type === "release" && r.status !== "held")
            ) {
              const receipt =
                input.type === "release" ? input.proof : input.receipt;
              invariant(
                receipt,
                "receipt_required",
                "Attempted effects require a verified receipt",
              );
              validateRef(receipt);
              requireScope(c, receipt);
              const actualUnits =
                input.type === "release" ? 0 : input.actualUnits;
              invariant(
                await this.#verifyReceipt({
                  tenantId: c.tenantId,
                  projectId: c.projectId,
                  budgetId,
                  reservationId: r.id,
                  effectKey: r.effectKey,
                  unit: state.unit,
                  outcome: input.type === "release" ? "no-charge" : "charge",
                  actualUnits,
                  receipt,
                }),
                "receipt_denied",
                "Receipt does not verify this effect and charge",
              );
            }
          }
          let next: BudgetState;
          switch (input.type) {
            case "reserve":
              next = reserve(state, c, input.input);
              break;
            case "commit":
              next = commitReservation(state, c, input.reservationId);
              break;
            case "uncertain":
              next = markUncertain(state, c, input.reservationId);
              break;
            case "release":
              if (input.proof) {
                validateRef(input.proof);
                requireScope(c, input.proof);
              }
              next = release(state, c, input.reservationId, input.proof);
              break;
            case "settle":
              next = settle(
                state,
                c,
                input.reservationId,
                input.actualUnits,
                input.receipt,
              );
              break;
            case "overage":
              next = recordOverage(
                state,
                c,
                input.reservationId,
                input.actualUnits,
                input.receipt,
                input.reason,
              );
              break;
            case "expire":
              next = expireReservations(state, c);
              break;
            default:
              throw new Error("Unsupported budget command");
          }
          if (digest(next) === digest(state)) return json(old);
          const row = await tx.put(
            "budget",
            idKey(budgetId),
            expectedRevision,
            next,
          );
          await tx.enqueue(
            "budget.changed",
            json({
              budgetId,
              revision: row.revision,
              balance: budgetBalance(next),
            }),
            digest({ budgetId, revision: row.revision }),
          );
          return json({ revision: row.revision, state: next });
        },
      ),
    ) as Promise<unknown> as Promise<BudgetSnapshot>;
  }
  /** Consume once before any external attempt. Lost acknowledgements require reconciliation. */
  async consumeEffect(
    context: Context,
    budgetId: string,
    expectedRevision: number,
    reservationId: string,
  ): Promise<EffectPermit> {
    const c = structuredClone(context);
    this.#scope(c);
    return scoped(this.#db, c, async (tx) => {
      const old = await this.#get(tx, c, budgetId);
      invariant(
        old.revision === expectedRevision,
        "revision_conflict",
        "Budget revision changed",
      );
      const r = old.state.reservations.find((r) => r.id === reservationId);
      invariant(
        r && r.status === "committed",
        "effect_consumed",
        "Effect is not committed or was already consumed",
      );
      invariant(
        r.purpose === c.purpose,
        "purpose_denied",
        "Effect purpose differs from reservation",
      );
      const next = markUncertain(old.state, c, reservationId);
      const row = await tx.put(
        "budget",
        idKey(budgetId),
        expectedRevision,
        next,
      );
      const permit: EffectPermit = {
        tenantId: c.tenantId,
        projectId: c.projectId,
        id: newId(),
        budgetId,
        reservationId,
        effectKey: r.effectKey,
        unit: old.state.unit,
        maximumUnits: r.units,
        purpose: r.purpose,
        actorId: c.actor.id,
        revision: row.revision,
      };
      await tx.audit("budget.effect_consumed", json(permit));
      return permit;
    });
  }
}
