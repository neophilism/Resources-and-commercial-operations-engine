import { scoped } from "@accountability/evidence/database";
import type { Database, UnitOfWork } from "@accountability/evidence/database";
import {
  canonical,
  DomainError,
  digest,
  invariant,
  newId,
  nonempty,
  validTime,
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
  allocateCost,
  verifyCostLedger,
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
export type AllocationLine = Readonly<{
  projectId: string;
  contributorId: string;
  units: number;
}>;
export type AllocationInput = Readonly<{
  budgetId: string;
  expectedBudgetRevision: number;
  reservationId: string;
  lines: readonly AllocationLine[];
}>;
export type AllocationSource = Scope &
  Readonly<{
    budget: Ref;
    budgetId: string;
    reservationId: string;
    purpose: string;
    effectKey: string;
    unit: string;
    totalUnits: number;
    receipt: Ref;
    costSequence: number;
    costHash: string;
  }>;
export type CostAllocation = Scope &
  Readonly<{
    source: AllocationSource;
    lines: readonly AllocationLine[];
    recordedBy: string;
    recordedAt: string;
  }>;
export type AllocationSnapshot = Readonly<{
  id: string;
  revision: number;
  value: CostAllocation;
}>;
export type AllocationCorrectionInput = Readonly<{
  budgetId: string;
  reservationId: string;
  expectedCorrectionRevision: number;
  lines: readonly AllocationLine[];
  reason: string;
}>;
export type AllocationCorrection = Scope &
  Readonly<{
    allocation: Ref;
    previous: Ref | null;
    lines: readonly AllocationLine[];
    reason: string;
    recordedBy: string;
    recordedAt: string;
  }>;
export type AllocationCorrectionSnapshot = Readonly<{
  id: string;
  revision: number;
  value: AllocationCorrection;
}>;
export type AllocationStatement = Scope &
  Readonly<{
    schemaVersion: 1;
    source: AllocationSource;
    observedBudget: Ref;
    allocation: Ref;
    correction: Ref | null;
    lines: readonly AllocationLine[];
  }>;
const CORRECTION = "cost-allocation-correction";
const MAX_CORRECTIONS = 64;
const correctionId = (id: string) =>
  digest({ kind: CORRECTION, allocationId: id });
const ALLOCATION = "cost-allocation";
const allocationId = (budgetId: string, reservationId: string) =>
  digest({ kind: ALLOCATION, budgetId, reservationId });
function allocationLines(
  lines: readonly AllocationLine[],
  total: number,
): AllocationLine[] {
  invariant(
    Array.isArray(lines) &&
      lines.length > 0 &&
      lines.length <= 256 &&
      Buffer.byteLength(canonical(lines)) <= 65536,
    "invalid_allocation",
    "Bounded allocation lines required",
  );
  const seen = new Set<string>(),
    projects = new Map<string, number>();
  for (const line of lines) {
    invariant(
      line &&
        Object.keys(line).length === 3 &&
        ["projectId", "contributorId", "units"].every((k) =>
          Object.hasOwn(line, k),
        ),
      "invalid_allocation",
      "Exact allocation fields required",
    );
    nonempty(line.projectId, "Allocation project", 128);
    nonempty(line.contributorId, "Contributor", 128);
    invariant(
      Number.isSafeInteger(line.units) && line.units >= 0,
      "invalid_units",
      "Safe nonnegative units required",
    );
    const key = canonical([line.projectId, line.contributorId]);
    invariant(
      !seen.has(key),
      "duplicate_allocation",
      "Project/contributor pair duplicated",
    );
    seen.add(key);
    const next = (projects.get(line.projectId) ?? 0) + line.units;
    invariant(
      Number.isSafeInteger(next),
      "overflow",
      "Allocation exceeds safe units",
    );
    projects.set(line.projectId, next);
  }
  allocateCost(
    total,
    [...projects].map(([projectId, units]) => ({ projectId, units })),
  );
  return structuredClone([...lines]);
}
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
  #commandAuthority(
    c: Context,
    state: BudgetState,
    input: BudgetCommand,
  ): void {
    if (input.type === "reserve") {
      const existing = state.reservations.find((r) => r.id === input.input.id);
      invariant(
        !existing ||
          (existing.owner.id === c.actor.id &&
            existing.owner.kind === c.actor.kind),
        "reservation_denied",
        "Reservation belongs to another principal",
      );
      invariant(
        input.input.purpose === c.purpose,
        "purpose_denied",
        "Reservation purpose differs from authenticated purpose",
      );
    }
    if (input.type === "overage")
      invariant(
        c.actor.kind === "human" && c.actor.roles.includes("owner"),
        "owner_required",
        "A human owner reconciles unexpected charges",
      );
    if ("reservationId" in input) {
      const r = state.reservations.find((r) => r.id === input.reservationId);
      invariant(r, "not_found", "Reservation not found");
      invariant(
        c.purpose === r.purpose,
        "purpose_denied",
        "Effect purpose differs from reservation",
      );
      invariant(
        (r.owner.id === c.actor.id && r.owner.kind === c.actor.kind) ||
          (c.actor.kind === "human" && c.actor.roles.includes("owner")),
        "reservation_denied",
        "Reservation belongs to another operator",
      );
    }
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
    return scoped(this.#db, c, async (tx) => {
      // Serialize authorization with budget changes before the SDK can return a
      // cached acknowledgement. Keep the original fingerprint for durable replay.
      await tx.audit(
        "budget.command.checked",
        json({ budgetId, type: input.type }),
      );
      const current = await this.#get(tx, c, budgetId);
      this.#commandAuthority(c, current.state, input);
      return tx.idempotent(
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
      );
    }) as Promise<unknown> as Promise<BudgetSnapshot>;
  }
  #allocationSource(
    c: Context,
    snapshot: BudgetSnapshot,
    budgetId: string,
    reservationId: string,
  ): AllocationSource {
    const s = snapshot.state,
      r = s.reservations.find((r) => r.id === reservationId);
    invariant(
      s.schemaVersion === 1 && s.id === budgetId && verifyCostLedger(s),
      "invalid_cost_ledger",
      "Exact intact budget ledger required",
    );
    invariant(
      r &&
        r.status === "settled" &&
        r.actualUnits !== null &&
        Number.isSafeInteger(r.actualUnits) &&
        r.actualUnits >= 0 &&
        r.receipt,
      "cost_unsettled",
      "Only a recorded settled charge can be allocated",
    );
    invariant(
      r.purpose === c.purpose,
      "purpose_denied",
      "Cost purpose differs from authenticated purpose",
    );
    nonempty(s.unit, "Unit", 64);
    nonempty(r.effectKey, "Effect", 200);
    validateRef(r.receipt);
    requireScope(c, r.receipt);
    const entries = s.entries.filter(
      (e) =>
        e.id === reservationId &&
        ["budget.settled", "budget.overage"].includes(e.type),
    );
    invariant(
      entries.length === 1 && entries[0]!.units === r.actualUnits,
      "invalid_cost_ledger",
      "One exact recorded charge required",
    );
    return {
      tenantId: c.tenantId,
      projectId: c.projectId,
      budget: {
        tenantId: c.tenantId,
        projectId: c.projectId,
        kind: "budget",
        id: idKey(budgetId),
        revision: snapshot.revision,
      },
      budgetId,
      reservationId,
      purpose: r.purpose,
      effectKey: r.effectKey,
      unit: s.unit,
      totalUnits: r.actualUnits,
      receipt: {
        tenantId: r.receipt.tenantId,
        projectId: r.receipt.projectId,
        kind: r.receipt.kind,
        id: r.receipt.id,
        revision: r.receipt.revision,
      },
      costSequence: entries[0]!.sequence,
      costHash: entries[0]!.hash,
    };
  }
  async #checkAllocation(
    tx: UnitOfWork,
    c: Context,
    row: AllocationSnapshot,
    source: AllocationSource,
  ): Promise<AllocationSnapshot> {
    invariant(
      row.value &&
        Object.keys(row.value).length === 6 &&
        [
          "tenantId",
          "projectId",
          "source",
          "lines",
          "recordedBy",
          "recordedAt",
        ].every((k) => Object.hasOwn(row.value, k)),
      "invalid_allocation",
      "Exact stored allocation required",
    );
    nonempty(row.value.recordedBy, "Recorded actor", 128);
    validTime(row.value.recordedAt);
    requireScope(c, row.value);
    requireScope(c, row.value.source);
    requireScope(c, row.value.source.budget);
    invariant(
      row.revision === 1 &&
        row.id === allocationId(source.budgetId, source.reservationId),
      "invalid_allocation",
      "Immutable allocation edition required",
    );
    const { budget, ...current } = source,
      { budget: recorded, ...stored } = row.value.source;
    invariant(
      digest(current) === digest(stored) &&
        recorded.kind === budget.kind &&
        recorded.id === budget.id &&
        Number.isSafeInteger(recorded.revision) &&
        recorded.revision > 0 &&
        recorded.revision <= budget.revision,
      "allocation_source_changed",
      "Recorded charge binding changed",
    );
    for (const ref of [row.value.source.budget, row.value.source.receipt])
      invariant(
        Object.keys(ref).length === 5 &&
          ["tenantId", "projectId", "kind", "id", "revision"].every((k) =>
            Object.hasOwn(ref, k),
          ),
        "invalid_allocation",
        "Exact stored reference required",
      );
    const historical = await tx.get<BudgetState>(
      "budget",
      budget.id,
      recorded.revision,
    );
    invariant(
      historical,
      "allocation_source_changed",
      "Recorded budget edition unavailable",
    );
    const original = this.#allocationSource(
      c,
      { revision: historical.revision, state: historical.value },
      source.budgetId,
      source.reservationId,
    );
    invariant(
      digest(original) === digest(row.value.source),
      "allocation_source_changed",
      "Exact original charge edition required",
    );
    allocationLines(row.value.lines, source.totalUnits);
    return row;
  }
  /** Immutable bookkeeping only. Does not change balances, grant capacity, pay or re-attest provider receipts. */
  async allocate(
    context: Context,
    supplied: AllocationInput,
    commandId: string,
  ): Promise<AllocationSnapshot> {
    const c = structuredClone(context),
      input = structuredClone(supplied);
    this.#manager(c);
    nonempty(commandId, "Command", 128);
    invariant(
      input &&
        Object.keys(input).length === 4 &&
        ["budgetId", "expectedBudgetRevision", "reservationId", "lines"].every(
          (k) => Object.hasOwn(input, k),
        ),
      "invalid_allocation",
      "Exact allocation input required",
    );
    nonempty(input.budgetId, "Budget", 128);
    nonempty(input.reservationId, "Reservation", 128);
    invariant(
      Number.isSafeInteger(input.expectedBudgetRevision) &&
        input.expectedBudgetRevision > 0,
      "invalid_revision",
      "Exact budget revision required",
    );
    // Validate bounded lines before SQL without trusting a caller-supplied total.
    invariant(
      Array.isArray(input.lines) &&
        input.lines.length > 0 &&
        input.lines.length <= 256 &&
        Buffer.byteLength(canonical(input.lines)) <= 65536,
      "invalid_allocation",
      "Bounded allocation lines required",
    );
    return scoped(this.#db, c, async (tx) => {
      await tx.audit("cost.allocation.checked", {
        budgetId: input.budgetId,
        reservationId: input.reservationId,
      });
      const snapshot = await this.#get(tx, c, input.budgetId),
        source = this.#allocationSource(
          c,
          snapshot,
          input.budgetId,
          input.reservationId,
        ),
        lines = allocationLines(input.lines, source.totalUnits),
        id = allocationId(input.budgetId, input.reservationId);
      const result = (await tx.idempotent(
        commandId,
        json({
          operation: "allocate-cost",
          input,
          actorKind: c.actor.kind,
          purpose: c.purpose,
        }),
        async () => {
          invariant(
            snapshot.revision === input.expectedBudgetRevision,
            "revision_conflict",
            "Budget revision changed",
          );
          invariant(
            !(await tx.get(ALLOCATION, id)),
            "already_allocated",
            "Charge already has an immutable allocation",
          );
          const value: CostAllocation = {
            tenantId: c.tenantId,
            projectId: c.projectId,
            source,
            lines,
            recordedBy: c.actor.id,
            recordedAt: c.now,
          };
          const saved = await tx.put(ALLOCATION, id, 0, json(value));
          await tx.audit("cost.allocated", {
            id,
            budgetId: input.budgetId,
            reservationId: input.reservationId,
            totalUnits: source.totalUnits,
            unit: source.unit,
          });
          await tx.enqueue(
            "cost.allocated",
            {
              id,
              revision: saved.revision,
              budgetId: input.budgetId,
              reservationId: input.reservationId,
            },
            id,
          );
          return json({ id, revision: saved.revision, value });
        },
      )) as unknown as AllocationSnapshot;
      return this.#checkAllocation(tx, c, result, source);
    });
  }
  async loadAllocation(
    context: Context,
    budgetId: string,
    reservationId: string,
  ): Promise<AllocationSnapshot | null> {
    const c = structuredClone(context);
    this.#manager(c);
    nonempty(budgetId, "Budget", 128);
    nonempty(reservationId, "Reservation", 128);
    return scoped(this.#db, c, async (tx) => {
      await tx.audit("cost.allocation.read.checked", {
        budgetId,
        reservationId,
      });
      const snapshot = await this.#get(tx, c, budgetId),
        source = this.#allocationSource(c, snapshot, budgetId, reservationId),
        id = allocationId(budgetId, reservationId);
      const row = await tx.get<CostAllocation>(ALLOCATION, id);
      return row
        ? this.#checkAllocation(
            tx,
            c,
            { id, revision: row.revision, value: row.value },
            source,
          )
        : null;
    });
  }
  async #originalAllocation(
    tx: UnitOfWork,
    c: Context,
    budgetId: string,
    reservationId: string,
  ): Promise<AllocationSnapshot> {
    const snapshot = await this.#get(tx, c, budgetId),
      source = this.#allocationSource(c, snapshot, budgetId, reservationId),
      id = allocationId(budgetId, reservationId),
      row = await tx.get<CostAllocation>(ALLOCATION, id);
    invariant(row, "allocation_required", "Original allocation required");
    return this.#checkAllocation(
      tx,
      c,
      { id, revision: row.revision, value: row.value },
      source,
    );
  }
  #allocationRef(c: Context, kind: string, id: string, revision: number): Ref {
    return { tenantId: c.tenantId, projectId: c.projectId, kind, id, revision };
  }
  async #checkCorrection(
    tx: UnitOfWork,
    c: Context,
    row: AllocationCorrectionSnapshot,
    original: AllocationSnapshot,
  ): Promise<AllocationCorrectionSnapshot> {
    invariant(
      row.id === correctionId(original.id) &&
        Number.isSafeInteger(row.revision) &&
        row.revision > 0 &&
        row.revision <= MAX_CORRECTIONS,
      "invalid_correction",
      "Bounded correction edition required",
    );
    // Follow every exact prior edition, never infer a lineage from a latest-only snapshot.
    let expectedLines = original.value.lines;
    for (let revision = 1; revision <= row.revision; revision++) {
      const stored = await tx.get<AllocationCorrection>(
        CORRECTION,
        row.id,
        revision,
      );
      invariant(
        stored && stored.revision === revision,
        "invalid_correction",
        "Correction history unavailable",
      );
      const value = stored.value;
      invariant(
        value &&
          Object.keys(value).length === 8 &&
          [
            "tenantId",
            "projectId",
            "allocation",
            "previous",
            "lines",
            "reason",
            "recordedBy",
            "recordedAt",
          ].every((k) => Object.hasOwn(value, k)),
        "invalid_correction",
        "Exact correction fields required",
      );
      requireScope(c, value);
      const root = this.#allocationRef(c, ALLOCATION, original.id, 1),
        previous =
          revision === 1
            ? null
            : this.#allocationRef(c, CORRECTION, row.id, revision - 1);
      invariant(
        digest(value.allocation) === digest(root) &&
          digest(value.previous) === digest(previous),
        "invalid_correction",
        "Exact original and predecessor editions required",
      );
      nonempty(value.reason, "Correction reason", 1000);
      nonempty(value.recordedBy, "Recorded actor", 128);
      validTime(value.recordedAt);
      allocationLines(value.lines, original.value.source.totalUnits);
      invariant(
        digest(value.lines) !== digest(expectedLines),
        "unchanged_allocation",
        "Correction must change allocation lines",
      );
      expectedLines = value.lines;
      if (revision === row.revision)
        invariant(
          digest(value) === digest(row.value),
          "invalid_correction",
          "Exact stored correction required",
        );
    }
    return row;
  }
  /** Explicit private bookkeeping correction. Original allocation and every prior edition remain immutable. */
  async correctAllocation(
    context: Context,
    supplied: AllocationCorrectionInput,
    commandId: string,
  ): Promise<AllocationCorrectionSnapshot> {
    const c = structuredClone(context),
      input = structuredClone(supplied);
    this.#manager(c);
    nonempty(commandId, "Command", 128);
    invariant(
      input &&
        Object.keys(input).length === 5 &&
        [
          "budgetId",
          "reservationId",
          "expectedCorrectionRevision",
          "lines",
          "reason",
        ].every((k) => Object.hasOwn(input, k)),
      "invalid_correction",
      "Exact correction input required",
    );
    nonempty(input.budgetId, "Budget", 128);
    nonempty(input.reservationId, "Reservation", 128);
    nonempty(input.reason, "Correction reason", 1000);
    invariant(
      Number.isSafeInteger(input.expectedCorrectionRevision) &&
        input.expectedCorrectionRevision >= 0 &&
        input.expectedCorrectionRevision < MAX_CORRECTIONS,
      "invalid_revision",
      "Correction revision must be0-63",
    );
    invariant(
      Array.isArray(input.lines) &&
        input.lines.length > 0 &&
        input.lines.length <= 256 &&
        Buffer.byteLength(canonical(input.lines)) <= 65536,
      "invalid_allocation",
      "Bounded allocation lines required",
    );
    return scoped(this.#db, c, async (tx) => {
      await tx.audit("cost.correction.checked", {
        budgetId: input.budgetId,
        reservationId: input.reservationId,
      });
      // Current operator, purpose and original/current charge editions precede cached acknowledgements.
      const original = await this.#originalAllocation(
          tx,
          c,
          input.budgetId,
          input.reservationId,
        ),
        lines = allocationLines(input.lines, original.value.source.totalUnits),
        id = correctionId(original.id);
      const result = (await tx.idempotent(
        commandId,
        json({
          operation: "correct-cost-allocation",
          input,
          actorKind: c.actor.kind,
          purpose: c.purpose,
        }),
        async () => {
          const current = await tx.get<AllocationCorrection>(CORRECTION, id);
          invariant(
            (current?.revision ?? 0) === input.expectedCorrectionRevision,
            "revision_conflict",
            "Correction revision changed",
          );
          if (current)
            await this.#checkCorrection(
              tx,
              c,
              { id, revision: current.revision, value: current.value },
              original,
            );
          invariant(
            digest(lines) !==
              digest(current?.value.lines ?? original.value.lines),
            "unchanged_allocation",
            "Correction must change allocation lines",
          );
          const value: AllocationCorrection = {
            tenantId: c.tenantId,
            projectId: c.projectId,
            allocation: this.#allocationRef(c, ALLOCATION, original.id, 1),
            previous: current
              ? this.#allocationRef(c, CORRECTION, id, current.revision)
              : null,
            lines,
            reason: input.reason,
            recordedBy: c.actor.id,
            recordedAt: c.now,
          };
          const saved = await tx.put(
            CORRECTION,
            id,
            input.expectedCorrectionRevision,
            json(value),
          );
          await tx.audit("cost.allocation.corrected", {
            id,
            revision: saved.revision,
            allocationId: original.id,
          });
          await tx.enqueue(
            "cost.allocation.corrected",
            { id, revision: saved.revision, allocationId: original.id },
            digest({ id, revision: saved.revision }),
          );
          return json({ id, revision: saved.revision, value });
        },
      )) as unknown as AllocationCorrectionSnapshot;
      return this.#checkCorrection(tx, c, result, original);
    });
  }
  /** Omit revision for latest correction; historical reads never claim to be current. Null means no recorded correction, not rollback proof. */
  async loadAllocationCorrection(
    context: Context,
    budgetId: string,
    reservationId: string,
    revision?: number,
  ): Promise<AllocationCorrectionSnapshot | null> {
    const c = structuredClone(context);
    this.#manager(c);
    nonempty(budgetId, "Budget", 128);
    nonempty(reservationId, "Reservation", 128);
    invariant(
      revision === undefined ||
        (Number.isSafeInteger(revision) &&
          revision > 0 &&
          revision <= MAX_CORRECTIONS),
      "invalid_revision",
      "Bounded correction edition required",
    );
    return scoped(this.#db, c, async (tx) => {
      await tx.audit("cost.correction.read.checked", {
        budgetId,
        reservationId,
      });
      const original = await this.#originalAllocation(
          tx,
          c,
          budgetId,
          reservationId,
        ),
        id = correctionId(original.id),
        row = await tx.get<AllocationCorrection>(CORRECTION, id, revision);
      return row
        ? this.#checkCorrection(
            tx,
            c,
            { id, revision: row.revision, value: row.value },
            original,
          )
        : null;
    });
  }
  /** One private SQL observation, not an external accounting attestation or action permit. */
  async loadAllocationStatement(
    context: Context,
    budgetId: string,
    reservationId: string,
  ): Promise<AllocationStatement> {
    const c = structuredClone(context);
    this.#manager(c);
    nonempty(budgetId, "Budget", 128);
    nonempty(reservationId, "Reservation", 128);
    return scoped(this.#db, c, async (tx) => {
      // Acquire the owning project lock before any source/allocation/correction read.
      await tx.audit("cost.statement.read.checked", {
        budgetId,
        reservationId,
      });
      const original = await this.#originalAllocation(
          tx,
          c,
          budgetId,
          reservationId,
        ),
        current = await this.#get(tx, c, budgetId),
        id = correctionId(original.id),
        stored = await tx.get<AllocationCorrection>(CORRECTION, id);
      const correction = stored
        ? await this.#checkCorrection(
            tx,
            c,
            { id, revision: stored.revision, value: stored.value },
            original,
          )
        : null;
      // Never persist this statement, return a cached command, or infer a new event/actor/time.
      return structuredClone({
        schemaVersion: 1 as const,
        tenantId: c.tenantId,
        projectId: c.projectId,
        source: original.value.source,
        observedBudget: this.#allocationRef(
          c,
          "budget",
          idKey(budgetId),
          current.revision,
        ),
        allocation: this.#allocationRef(
          c,
          ALLOCATION,
          original.id,
          original.revision,
        ),
        correction: correction
          ? this.#allocationRef(
              c,
              CORRECTION,
              correction.id,
              correction.revision,
            )
          : null,
        lines: correction?.value.lines ?? original.value.lines,
      });
    });
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
