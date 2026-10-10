/**
 * Autonoblog — DAL: billing, plans, subscriptions, usage metering, credits.
 *
 * This module records what exists; it never charges anything. There is no
 * payment processor wired (Stripe comes later), no invoice table, and no
 * pricing decision baked in: `plans.monthly_price_cents` is 0 until the owner
 * ratifies price points. Every value returned here is read from the database.
 *
 * Notes on numbers: BIGINT columns and SUM() aggregates come back from Neon as
 * strings, from SQLite as numbers. `toNum()` normalises both, and every public
 * function returns plain numbers, so callers never see a string amount.
 */
import { all, get, run, nowIso } from "../store";
import type { PlanLimits } from "../plans";

// ---- Types -----------------------------------------------------------------

export interface PlanRow {
  id: number;
  key: string;
  name: string;
  monthly_price_cents: number;
  limits: PlanLimits;
  active: number;
  created_at: string;
}

export interface SubscriptionRow {
  id: number;
  user_id: number;
  plan_id: number;
  status: SubscriptionStatus;
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: number;
  created_at: string;
  updated_at: string;
}

export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled";

/** A subscription joined with the plan it points at (what the UI needs). */
export interface SubscriptionWithPlan extends SubscriptionRow {
  plan_key: string;
  plan_name: string;
  plan_limits: PlanLimits;
  monthly_price_cents: number;
}

export interface UsagePeriod {
  /** ISO-8601 timestamp of the period start (inclusive). */
  start: string;
  /** ISO-8601 timestamp of the period end (exclusive). */
  end: string;
}

export interface UsageSummary {
  period: UsagePeriod;
  /** Metric key -> amount used in the period. */
  used: Record<string, number>;
  /** Effective limits from the user's plan; -1 means unlimited. */
  limits: PlanLimits;
  /** Metric key -> remaining allowance (null when the metric has no plan limit). */
  remaining: Record<string, number | null>;
  credits: { balance: number; granted: number; spent: number };
  plan: { id: number; key: string; name: string; monthly_price_cents: number } | null;
  subscription: {
    id: number;
    status: SubscriptionStatus;
    current_period_start: string;
    current_period_end: string;
    cancel_at_period_end: boolean;
  } | null;
}

/** Result of assertLimit — returned, never thrown (see doc below). */
export interface LimitCheck {
  ok: boolean;
  metric: string;
  needed: number;
  /** Plan limit for this metric, -1 when unlimited, null when unmetered. */
  limit: number | null;
  used: number;
  /** Remaining allowance; null when the metric has no plan limit. */
  remaining: number | null;
  unlimited: boolean;
  /** True only for ai_credits, where purchased credits extend the plan allowance. */
  creditsIncluded: number;
  reason?: string;
}

// ---- Helpers ---------------------------------------------------------------

function toNum(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function parseLimits(raw: unknown): PlanLimits {
  const fallback: PlanLimits = {
    max_blogs: 0,
    ai_credits_per_month: 0,
    storage_bytes: 0,
    posts_per_month: 0,
    social_accounts: 0,
    plugins: 0,
  };
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<PlanLimits>;
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

/** Metric name -> the key it is limited by in `plans.limits`. */
export const METRIC_LIMIT_KEY: Record<string, keyof PlanLimits> = {
  ai_credits: "ai_credits_per_month",
  storage_bytes: "storage_bytes",
  posts_published: "posts_per_month",
  social_accounts: "social_accounts",
  plugins: "plugins",
  blogs: "max_blogs",
};

/** The current calendar month, as the period usage is metered in. */
export function currentPeriod(now: Date = new Date()): UsagePeriod {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(y, m, 1, 0, 0, 0, 0)).toISOString(),
    end: new Date(Date.UTC(y, m + 1, 1, 0, 0, 0, 0)).toISOString(),
  };
}

function mapPlan(row: Record<string, unknown>): PlanRow {
  return {
    id: toNum(row.id),
    key: String(row.key ?? ""),
    name: String(row.name ?? ""),
    monthly_price_cents: toNum(row.monthly_price_cents),
    limits: parseLimits(row.limits),
    active: toNum(row.active),
    created_at: String(row.created_at ?? ""),
  };
}

function mapSubscription(row: Record<string, unknown>): SubscriptionWithPlan {
  return {
    id: toNum(row.id),
    user_id: toNum(row.user_id),
    plan_id: toNum(row.plan_id),
    status: String(row.status ?? "active") as SubscriptionStatus,
    current_period_start: String(row.current_period_start ?? ""),
    current_period_end: String(row.current_period_end ?? ""),
    cancel_at_period_end: toNum(row.cancel_at_period_end),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    plan_key: String(row.plan_key ?? ""),
    plan_name: String(row.plan_name ?? ""),
    plan_limits: parseLimits(row.plan_limits),
    monthly_price_cents: toNum(row.monthly_price_cents),
  };
}

// ---- Plans -----------------------------------------------------------------

/** All plans, cheapest first (active first so the picker never looks empty). */
export async function listPlans(): Promise<PlanRow[]> {
  const rows = await all<Record<string, unknown>>(
    "SELECT * FROM plans ORDER BY active DESC, monthly_price_cents ASC, id ASC"
  );
  return rows.map(mapPlan);
}

export async function getPlanByKey(key: string): Promise<PlanRow | null> {
  const row = await get<Record<string, unknown>>(
    "SELECT * FROM plans WHERE key = ?",
    key
  );
  return row ? mapPlan(row) : null;
}

export async function getPlanById(id: number): Promise<PlanRow | null> {
  const row = await get<Record<string, unknown>>(
    "SELECT * FROM plans WHERE id = ?",
    id
  );
  return row ? mapPlan(row) : null;
}

// ---- Subscriptions ---------------------------------------------------------

/**
 * The user's current subscription with its plan, or null when the user has
 * none. "Current" = the newest row. Canceled rows are still returned (with
 * status 'canceled') so the UI can tell "never subscribed" apart from
 * "cancelled"; callers that only want a live plan should check `status`.
 */
export async function getActiveSubscription(
  userId: number
): Promise<SubscriptionWithPlan | null> {
  const row = await get<Record<string, unknown>>(
    `SELECT s.*, p.key AS plan_key, p.name AS plan_name, p.limits AS plan_limits,
            p.monthly_price_cents AS monthly_price_cents
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
      WHERE s.user_id = ?
      ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trialing' THEN 1 WHEN 'past_due' THEN 2 ELSE 3 END,
               s.created_at DESC, s.id DESC
      LIMIT 1`,
    userId
  );
  return row ? mapSubscription(row) : null;
}

/**
 * Subscribe `userId` to `planKey`: cancels any current active/trialing
 * subscription and creates a new active row with a 30-day period starting now.
 * No payment is taken — this is the record of intent until Stripe is wired.
 */
export async function subscribeUser(
  userId: number,
  planKey: string
): Promise<SubscriptionWithPlan> {
  const plan = await getPlanByKey(planKey);
  if (!plan) throw new Error(`Unknown plan: ${planKey}`);
  if (!plan.active) throw new Error(`Plan is not active: ${planKey}`);
  const now = new Date();
  const start = now.toISOString();
  const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await run(
    `UPDATE subscriptions
        SET status = 'canceled', cancel_at_period_end = 0, updated_at = ?
      WHERE user_id = ? AND status IN ('active', 'trialing', 'past_due')`,
    start,
    userId
  );
  const info = await run(
    `INSERT INTO subscriptions
       (user_id, plan_id, status, current_period_start, current_period_end,
        cancel_at_period_end, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?, 0, ?, ?)`,
    userId,
    plan.id,
    start,
    end,
    start,
    start
  );
  const created = await getActiveSubscription(userId);
  if (!created) {
    throw new Error(
      `Subscription insert did not produce a row (id ${info.lastInsertRowid})`
    );
  }
  return created;
}

/** Mark a subscription to stop renewing at period end (no charge is involved). */
export async function setCancelAtPeriodEnd(
  subscriptionId: number,
  cancel: boolean
): Promise<void> {
  await run(
    "UPDATE subscriptions SET cancel_at_period_end = ?, updated_at = ? WHERE id = ?",
    cancel ? 1 : 0,
    nowIso(),
    subscriptionId
  );
}

// ---- Usage metering --------------------------------------------------------

/**
 * Add `amount` to `userId`'s usage of `metric` for `period` (defaults to the
 * current calendar month). Upsert: one row per (user, metric, period), so
 * repeated calls accumulate. Returns the new period total.
 */
export async function recordUsage(
  userId: number,
  metric: string,
  amount: number,
  period: UsagePeriod = currentPeriod()
): Promise<number> {
  const now = nowIso();
  await run(
    `INSERT INTO usage_records
       (user_id, metric, period_start, period_end, amount, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, metric, period_start, period_end)
     DO UPDATE SET amount = usage_records.amount + ?, updated_at = ?`,
    userId,
    metric,
    period.start,
    period.end,
    amount,
    now,
    amount,
    now
  );
  return getUsageForPeriod(userId, metric, period);
}

/** Total usage of one metric in a period (0 when nothing was recorded). */
export async function getUsageForPeriod(
  userId: number,
  metric: string,
  period: UsagePeriod = currentPeriod()
): Promise<number> {
  const row = await get<{ amount: unknown }>(
    `SELECT amount FROM usage_records
      WHERE user_id = ? AND metric = ? AND period_start = ? AND period_end = ?`,
    userId,
    metric,
    period.start,
    period.end
  );
  return toNum(row?.amount);
}

/** Every metric recorded for the user in the period, as { metric: amount }. */
export async function listUsage(
  userId: number,
  period: UsagePeriod = currentPeriod()
): Promise<Record<string, number>> {
  const rows = await all<{ metric: string; amount: unknown }>(
    `SELECT metric, amount FROM usage_records
      WHERE user_id = ? AND period_start = ? AND period_end = ?
      ORDER BY metric ASC`,
    userId,
    period.start,
    period.end
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.metric)] = toNum(r.amount);
  return out;
}

// ---- Credits ---------------------------------------------------------------

/**
 * Append a credit ledger entry. Positive grants credits, negative spends them.
 * Returns the balance after the entry. Nothing here charges money.
 */
export async function addCredit(
  userId: number,
  amount: number,
  reason: string,
  reference?: string | null
): Promise<number> {
  await run(
    `INSERT INTO credit_transactions (user_id, amount, reason, reference, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    userId,
    amount,
    reason,
    reference ?? null,
    nowIso()
  );
  return getCreditBalance(userId);
}

/** Sum of the credit ledger for the user (grants minus spends). */
export async function getCreditBalance(userId: number): Promise<number> {
  const row = await get<{ total: unknown }>(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM credit_transactions WHERE user_id = ?",
    userId
  );
  return toNum(row?.total);
}

/** Credit ledger entries, newest first. */
export async function listCreditTransactions(
  userId: number,
  limit = 50
): Promise<
  { id: number; amount: number; reason: string; reference: string | null; created_at: string }[]
> {
  const rows = await all<Record<string, unknown>>(
    `SELECT id, amount, reason, reference, created_at FROM credit_transactions
      WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    userId,
    limit
  );
  return rows.map((r) => ({
    id: toNum(r.id),
    amount: toNum(r.amount),
    reason: String(r.reason ?? ""),
    reference: r.reference === null || r.reference === undefined ? null : String(r.reference),
    created_at: String(r.created_at ?? ""),
  }));
}

// ---- Limits ----------------------------------------------------------------

/**
 * Check whether the user still has room for `needed` more units of `metric`.
 *
 * Contract (deliberate): this NEVER throws for a business limit — it returns
 * `{ ok, metric, needed, limit, used, remaining, unlimited, creditsIncluded }`
 * so callers can show an accurate paywall/limit message instead of a stack
 * trace. It throws only if the database query itself fails.
 *   - `reachable` allowance = plan limit (-1 = unlimited).
 *   - For `ai_credits` the credit ledger balance is added on top, because
 *     granted credits are spendable beyond the plan's monthly allowance.
 *   - A metric with no key in `plans.limits` (e.g. 'bandwidth') is unmetered:
 *     limit/remaining are null and ok is true.
 */
export async function assertLimit(
  userId: number,
  metric: string,
  needed: number
): Promise<LimitCheck> {
  const [sub, used, balance] = await Promise.all([
    getActiveSubscription(userId),
    getUsageForPeriod(userId, metric),
    getCreditBalance(userId),
  ]);
  const limits = sub?.plan_limits ?? null;
  const limitKey = METRIC_LIMIT_KEY[metric];
  if (!limits || !limitKey) {
    return {
      ok: true,
      metric,
      needed,
      limit: null,
      used,
      remaining: null,
      unlimited: false,
      creditsIncluded: 0,
      reason: limits ? "Metric has no plan limit" : "No plan limits (no subscription)",
    };
  }
  const raw = limits[limitKey];
  const unlimited = raw === -1;
  const creditsIncluded = metric === "ai_credits" ? Math.max(balance, 0) : 0;
  const allowance = unlimited ? Infinity : Math.max(raw, 0) + creditsIncluded;
  const remaining = unlimited ? null : allowance - used;
  const ok = unlimited || remaining !== null && remaining >= needed;
  return {
    ok,
    metric,
    needed,
    limit: raw,
    used,
    remaining: remaining === null ? null : Math.max(remaining, 0),
    unlimited,
    creditsIncluded,
    ...(ok
      ? {}
      : {
          reason: `Plan limit reached for ${metric}: ${used} used of ${raw}${creditsIncluded ? ` (+${creditsIncluded} credits)` : ""}`,
        }),
  };
}

// ---- Aggregate -------------------------------------------------------------

/**
 * Everything a billing/usage screen needs, in one call: current period, used
 * amounts, effective plan limits, remaining allowance per metric, credit
 * balance and the (unpriced) plan. Real rows only — if the user has no
 * subscription the plan/subscription fields are null and used is {}.
 */
export async function getUsageSummary(userId: number): Promise<UsageSummary> {
  const period = currentPeriod();
  const [used, sub, credits] = await Promise.all([
    listUsage(userId, period),
    getActiveSubscription(userId),
    getCreditBalance(userId),
  ]);
  const granted = toNum(
    (
      await get<{ total: unknown }>(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM credit_transactions WHERE user_id = ? AND amount > 0",
        userId
      )
    )?.total
  );
  const spent = granted - credits;
  const limits: PlanLimits = sub?.plan_limits ?? {
    max_blogs: 0,
    ai_credits_per_month: 0,
    storage_bytes: 0,
    posts_per_month: 0,
    social_accounts: 0,
    plugins: 0,
  };
  const remaining: Record<string, number | null> = {};
  for (const [metric, key] of Object.entries(METRIC_LIMIT_KEY)) {
    const limit = limits[key as keyof PlanLimits];
    remaining[metric] =
      limit === -1
        ? null
        : Math.max(limit - (used[metric] ?? 0), 0) +
          (metric === "ai_credits" ? Math.max(credits, 0) : 0);
  }
  const live = sub && (sub.status === "active" || sub.status === "trialing");
  return {
    period,
    used,
    limits,
    remaining,
    credits: { balance: credits, granted, spent: spent < 0 ? 0 : spent },
    plan: live
      ? {
          id: sub.plan_id,
          key: sub.plan_key,
          name: sub.plan_name,
          monthly_price_cents: sub.monthly_price_cents,
        }
      : null,
    subscription: sub
      ? {
          id: sub.id,
          status: sub.status,
          current_period_start: sub.current_period_start,
          current_period_end: sub.current_period_end,
          cancel_at_period_end: sub.cancel_at_period_end === 1,
        }
      : null,
  };
}
