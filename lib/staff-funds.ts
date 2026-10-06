import "server-only";
import { Prisma, type PrismaClient } from "@prisma/client";
import { lockAccountBalance } from "@/lib/account-lock";
import { checkBalanceDebit } from "@/lib/margin";
import { hasEligibleApprover } from "@/lib/approvers";
import { approveFundsRequest, FundsRequestRaceError } from "@/lib/funds-approval";
import { nextPspStatusOnMark } from "@/lib/psp/adapter";

type Tx = Prisma.TransactionClient;

// DEP item (owner 2026-10-05, decisions 1-3): staff record a real DEPOSIT or WITHDRAWAL on a client's account from the
// backoffice (Account menu Deposit... / Withdraw..., DEP header New deposit... / New withdrawal...). Contract:
// docs/contracts/staff-funds.md. The row is the same DEPOSIT/WITHDRAWAL Transaction a client request creates, so every
// deposit total counts it; it is told apart by createdByAdminId + pspAdapter "STAFF". Completion always goes through
// approveFundsRequest, so ledger, audit, events and notifications match an approved client request exactly.
//
// Who completes what (owner decisions 1 + 2):
//   DEPOSIT     BROKER_ADMIN -> completed at once. MANAGER -> Waiting; a DIFFERENT admin approves it on DEP.
//   WITHDRAWAL  Broker.withdrawalApproval SINGLE + BROKER_ADMIN -> completed at once. Otherwise it is created already
//               marked by the creator (first approval) and a different admin completes it. A MANAGER never completes one.

export const MANUAL_METHOD_ID = "MANUAL";
export const MANUAL_METHOD_NAME = "Manual / Bank transfer";
export const STAFF_PSP_ADAPTER = "STAFF";
export const STAFF_REFERENCE_TYPE = "STAFF_FUNDS"; // Transaction.referenceType; referenceId = the idempotency key

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  USDT_TRC20: "USDT (TRC20)",
  USDT_BEP20: "USDT (BEP20)",
  BTC: "Bitcoin",
  ETH: "Ethereum",
  BANK_TRANSFER: "Bank transfer",
};

/** The payment method name shown on a funds row (DEP, history). Staff MANUAL rows have no method. */
export function paymentMethodName(row: { pspAdapter: string | null; paymentMethod: { type: string } | null }): string | null {
  if (row.paymentMethod) return PAYMENT_METHOD_LABELS[row.paymentMethod.type] ?? row.paymentMethod.type;
  return row.pspAdapter === STAFF_PSP_ADAPTER ? MANUAL_METHOD_NAME : null;
}

export type StaffFundsCode =
  | "AMOUNT_INVALID"
  | "NOTE_REQUIRED"
  | "NOTE_TOO_LONG"
  | "METHOD_INVALID"
  | "REFERENCE_TOO_LONG"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "TYPE_INVALID"
  | "FORBIDDEN"
  | "KYC_REQUIRED"
  | "NOT_FOUND"
  | "INSUFFICIENT_BALANCE"
  | "MARGIN_TOO_LOW"
  | "NO_CONVERSION_RATE"
  | "ACCOUNT_NOT_ACTIVE"
  | "NO_APPROVER";

const STATUS_FOR: Record<StaffFundsCode, number> = {
  AMOUNT_INVALID: 400,
  NOTE_REQUIRED: 400,
  NOTE_TOO_LONG: 400,
  METHOD_INVALID: 400,
  REFERENCE_TOO_LONG: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  TYPE_INVALID: 400,
  FORBIDDEN: 403,
  KYC_REQUIRED: 403,
  NOT_FOUND: 404,
  INSUFFICIENT_BALANCE: 409,
  MARGIN_TOO_LOW: 409,
  NO_CONVERSION_RATE: 409,
  ACCOUNT_NOT_ACTIVE: 409,
  NO_APPROVER: 409,
};

export class StaffFundsError extends Error {
  constructor(
    readonly code: StaffFundsCode,
    message: string
  ) {
    super(message);
  }
  get status(): number {
    return STATUS_FOR[this.code];
  }
}

export type StaffFundsInput = {
  type: "DEPOSIT" | "WITHDRAWAL";
  amount: Prisma.Decimal; // positive
  paymentMethodId: string;
  reference: string | null;
  note: string;
  idempotencyKey: string;
};

const MAX_AMOUNT = new Prisma.Decimal("99999999999.99");

/** Pure body validation (no DB). Throws StaffFundsError with a 400 code. */
export function parseStaffFundsBody(body: unknown): StaffFundsInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const type = b.type === "DEPOSIT" || b.type === "WITHDRAWAL" ? b.type : null;
  if (!type) throw new StaffFundsError("TYPE_INVALID", "type must be DEPOSIT or WITHDRAWAL");

  const raw = typeof b.amount === "number" ? (Number.isFinite(b.amount) ? String(b.amount) : "") : typeof b.amount === "string" ? b.amount.trim() : "";
  // at most 2 decimals, no sign, no exponent: "1e3", "-5", "0.001" and "" are all refused
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw new StaffFundsError("AMOUNT_INVALID", "amount must be a positive number with at most 2 decimals");
  const amount = new Prisma.Decimal(raw);
  if (!amount.gt(0) || amount.gt(MAX_AMOUNT)) throw new StaffFundsError("AMOUNT_INVALID", "amount must be greater than 0");

  const paymentMethodId = typeof b.paymentMethodId === "string" ? b.paymentMethodId.trim() : "";
  if (!paymentMethodId) throw new StaffFundsError("METHOD_INVALID", "choose a payment method");

  let reference: string | null = null;
  if (b.reference !== undefined && b.reference !== null) {
    if (typeof b.reference !== "string") throw new StaffFundsError("REFERENCE_TOO_LONG", "reference must be text of at most 100 characters");
    const r = b.reference.trim();
    if (r.length > 100) throw new StaffFundsError("REFERENCE_TOO_LONG", "reference must be at most 100 characters");
    reference = r || null;
  }

  const note = typeof b.note === "string" ? b.note.trim() : "";
  if (!note) throw new StaffFundsError("NOTE_REQUIRED", "a reason is required");
  if (note.length > 500) throw new StaffFundsError("NOTE_TOO_LONG", "reason must be at most 500 characters");

  const idempotencyKey = typeof b.idempotencyKey === "string" ? b.idempotencyKey.trim() : "";
  if (!idempotencyKey || idempotencyKey.length > 100) throw new StaffFundsError("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required (at most 100 characters)");

  return { type, amount, paymentMethodId, reference, note, idempotencyKey };
}

export type StaffActor = { adminId: string; role: "BROKER_ADMIN" | "MANAGER"; brokerId: string };

export type StaffFundsOutcome =
  | { status: "COMPLETED"; transactionId: string; balanceAfter: string; pending: false; replayed: boolean; warnings: string[] }
  | { status: "PENDING"; transactionId: string; pending: true; step: "WAITING" | "APPROVED_BY_FIRST_ADMIN"; replayed: boolean; warnings: string[] }
  | { status: "REJECTED" | "CANCELLED"; transactionId: string; pending: false; replayed: true; warnings: string[] };

type StoredRow = { id: string; status: string; balanceAfter: Prisma.Decimal; markedByAdminId: string | null };

function outcomeOf(row: StoredRow, replayed: boolean, warnings: string[]): StaffFundsOutcome {
  if (row.status === "COMPLETED") return { status: "COMPLETED", transactionId: row.id, balanceAfter: row.balanceAfter.toFixed(2), pending: false, replayed, warnings };
  if (row.status === "PENDING") return { status: "PENDING", transactionId: row.id, pending: true, step: row.markedByAdminId ? "APPROVED_BY_FIRST_ADMIN" : "WAITING", replayed, warnings };
  return { status: row.status as "REJECTED" | "CANCELLED", transactionId: row.id, pending: false, replayed: true, warnings };
}

async function findByKey(db: PrismaClient | Tx, brokerId: string, key: string): Promise<StoredRow | null> {
  return db.transaction.findFirst({
    where: { brokerId, referenceType: STAFF_REFERENCE_TYPE, referenceId: key },
    select: { id: true, status: true, balanceAfter: true, markedByAdminId: true },
  });
}

/**
 * Records a staff deposit/withdrawal. The account must already be known to belong to actor.brokerId (the route
 * checks, 404 otherwise). Returns the outcome; throws StaffFundsError for every refusal. Nothing is written when it
 * throws (one transaction). A repeated idempotency key returns the original row's outcome and writes nothing.
 */
export async function recordStaffFunds(
  prisma: PrismaClient,
  actor: StaffActor,
  accountId: string,
  input: StaffFundsInput
): Promise<StaffFundsOutcome> {
  const prior = await findByKey(prisma, actor.brokerId, input.idempotencyKey);
  if (prior) return outcomeOf(prior, true, []);

  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId }, select: { status: true, balance: true } });
  // Owner 2026-10-06: a staff WITHDRAWAL is allowed on a SUSPENDED or CLOSED account (paying the client out); a staff
  // DEPOSIT into one is refused. Every other withdrawal guard (balance, margin, approval) still applies.
  if (account.status !== "ACTIVE" && input.type === "DEPOSIT") throw new StaffFundsError("ACCOUNT_NOT_ACTIVE", "the account is not active: deposits are refused");

  // Payment method (decision 3): the built-in MANUAL method is always accepted; any other id must be one of the
  // broker's enabled methods. Its min/max are NOT enforced for staff, only reported back as warnings.
  const warnings: string[] = [];
  let paymentMethodId: string | null = null;
  if (input.paymentMethodId !== MANUAL_METHOD_ID) {
    const pm = await prisma.paymentMethod.findUnique({ where: { id: input.paymentMethodId } });
    if (!pm || pm.brokerId !== actor.brokerId || !pm.enabled) throw new StaffFundsError("METHOD_INVALID", "unknown or disabled payment method");
    paymentMethodId = pm.id;
    if (input.amount.lt(pm.minAmount)) warnings.push("BELOW_METHOD_MIN");
    if (pm.maxAmount && input.amount.gt(pm.maxAmount)) warnings.push("ABOVE_METHOD_MAX");
  }

  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: actor.brokerId }, select: { withdrawalApproval: true } });
  const completesNow =
    input.type === "DEPOSIT" ? actor.role === "BROKER_ADMIN" : actor.role === "BROKER_ADMIN" && broker.withdrawalApproval === "SINGLE";
  const marked = input.type === "WITHDRAWAL" && !completesNow; // the creator's own entry is the first approval

  // Owner 2026-10-06: no KYC check here. A staff deposit or withdrawal is the broker's own decision; the KYC rule is
  // for the client's own withdrawal requests only (app/api/trade/funds-requests).
  // a request nobody else could ever approve is refused when filed (web5, lib/approvers.ts)
  if (!completesNow && !(await hasEligibleApprover(prisma, actor.brokerId, actor.adminId, "FUNDS_APPROVAL"))) {
    throw new StaffFundsError("NO_APPROVER", "needs a broker admin: no other staff member of this broker can approve this request");
  }

  const signed = input.type === "WITHDRAWAL" ? input.amount.negated() : input.amount;

  try {
    const row = await prisma.$transaction(async (tx): Promise<{ replay: StoredRow } | { row: StoredRow }> => {
      // concurrent submits of one key queue here; the loser then finds the winner's row
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.brokerId}:${STAFF_REFERENCE_TYPE}:${input.idempotencyKey}`}, 0))`;
      const again = await findByKey(tx, actor.brokerId, input.idempotencyKey);
      if (again) return { replay: again };

      const balance = await lockAccountBalance(tx, accountId);
      if (input.type === "WITHDRAWAL") {
        // checked on the locked balance for a Waiting withdrawal too, so nobody files one that could not be paid now
        // (approveFundsRequest checks again when it is completed)
        const debit = await checkBalanceDebit(tx, { accountId, amount: input.amount, balance });
        if (debit) {
          const code = debit.error === "BALANCE_BELOW_ZERO" ? "INSUFFICIENT_BALANCE" : debit.error === "NO_CONVERSION_RATE" ? "NO_CONVERSION_RATE" : "MARGIN_TOO_LOW";
          throw new StaffFundsError(code, `withdrawal refused: ${debit.message}`);
        }
      }

      const now = new Date();
      const created = await tx.transaction.create({
        data: {
          brokerId: actor.brokerId,
          accountId,
          type: input.type,
          status: "PENDING",
          amount: signed,
          balanceBefore: balance,
          balanceAfter: balance,
          note: input.note,
          createdByAdminId: actor.adminId,
          paymentMethodId,
          pspAdapter: STAFF_PSP_ADAPTER,
          pspStatus: marked ? nextPspStatusOnMark() : input.type === "DEPOSIT" ? "PENDING" : "REQUESTED",
          pspReference: input.reference,
          referenceType: STAFF_REFERENCE_TYPE,
          referenceId: input.idempotencyKey,
          ...(marked ? { markedByAdminId: actor.adminId, markedAt: now } : {}),
        },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: {
          brokerId: actor.brokerId,
          actorAdminId: actor.adminId,
          action: "FUNDS_STAFF_RECORDED",
          entityType: "Transaction",
          entityId: created.id,
          newValue: {
            type: input.type,
            amount: signed.toString(),
            paymentMethod: paymentMethodId ?? MANUAL_METHOD_ID,
            reference: input.reference,
            outcome: completesNow ? "COMPLETED" : marked ? "APPROVED_BY_FIRST_ADMIN" : "WAITING",
            ...(warnings.length ? { warnings } : {}),
          },
        },
      });

      if (!completesNow) {
        return { row: { id: created.id, status: "PENDING", balanceAfter: balance, markedByAdminId: marked ? actor.adminId : null } };
      }
      const approved = await approveFundsRequest(tx, {
        transactionId: created.id,
        brokerId: actor.brokerId,
        accountId,
        amount: signed,
        adminId: actor.adminId,
        note: null,
        type: input.type,
        approvalMode: input.type === "WITHDRAWAL" ? "SINGLE" : undefined,
        markedByAdminId: null,
        requireKyc: false,
      });
      // a refusal rolls back the row created above: nothing is left behind
      if (!approved.ok) throw new StaffFundsError(approved.code, approved.error);
      return { row: { id: created.id, status: "COMPLETED", balanceAfter: approved.balanceAfter, markedByAdminId: null } };
    });
    if ("replay" in row) return outcomeOf(row.replay, true, []);
    return outcomeOf(row.row, false, warnings);
  } catch (err) {
    if (err instanceof FundsRequestRaceError) {
      const winner = await findByKey(prisma, actor.brokerId, input.idempotencyKey);
      if (winner) return outcomeOf(winner, true, []);
    }
    throw err;
  }
}
