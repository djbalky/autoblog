/**
 * Autonoblog — server RPCs for billing & usage (foundation extension).
 *
 * Real data only: every field is read from the database through the DAL. A user
 * with no subscription row gets `plan: null` and `subscription: null` — the
 * function never invents a plan or a limit. Nothing here charges money.
 *
 * No pricing is applied and no payment processor is wired yet (Stripe later),
 * so `monthly_price_cents` is reported exactly as stored.
 */
import { createServerFn } from "@tanstack/react-start";
import { currentUser } from "../auth-context";
import { ensureInitialized } from "../init";
import {
  getUsageSummary,
  getCreditBalance,
  listPlans,
  listCreditTransactions,
  type PlanRow,
  type UsageSummary,
} from "../dal/billing";
import {
  listContentJobs,
  getContentJob,
  type ContentJobRow,
} from "../dal/contentJobs";

export interface ActionResult<T = unknown> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface BillingOverview {
  /** The plan the user is actually on (null when there is no subscription). */
  plan: UsageSummary["plan"];
  subscription: UsageSummary["subscription"];
  /** Used amounts, effective limits and remaining allowance for this period. */
  usage: UsageSummary;
  credits: { balance: number; granted: number; spent: number };
  /** Recent credit ledger entries (real rows, newest first). */
  creditHistory: {
    id: number;
    amount: number;
    reason: string;
    reference: string | null;
    created_at: string;
  }[];
  /** Plans that exist in the database; useful for a plan picker later. */
  availablePlans: PlanRow[];
  /** Whether a payment processor is connected. Currently always false. */
  paymentProcessor: { provider: "stripe"; connected: false; note: string };
}

/**
 * Everything a billing/usage screen needs for the signed-in user.
 * Returns `{ ok: false, error: "Not authenticated" }` when there is no session
 * (rather than redirecting, because an RPC result is easier for a UI to show).
 */
export const getBillingOverview = createServerFn({ method: "GET" }).handler(
  async (): Promise<ActionResult<BillingOverview>> => {
    await ensureInitialized();
    const user = await currentUser();
    if (!user) return { ok: false, error: "Not authenticated" };
    try {
      const [summary, credits, plans, history] = await Promise.all([
        getUsageSummary(user.id),
        getCreditBalance(user.id),
        listPlans(),
        listCreditTransactions(user.id, 20),
      ]);
      return {
        ok: true,
        data: {
          plan: summary.plan,
          subscription: summary.subscription,
          usage: summary,
          credits: { balance: credits, ...summary.credits },
          creditHistory: history,
          availablePlans: plans,
          paymentProcessor: {
            provider: "stripe",
            connected: false,
            note: "No payment processor is connected. Plans and usage are recorded, nothing is charged.",
          },
        },
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
);

/** The signed-in user's ContentJobs, newest first (Phase 6 pipeline read view). */
export const getMyContentJobs = createServerFn({ method: "GET" }).handler(
  async (): Promise<ActionResult<{ jobs: ContentJobRow[] }>> => {
    await ensureInitialized();
    const user = await currentUser();
    if (!user) return { ok: false, error: "Not authenticated" };
    try {
      return { ok: true, data: { jobs: await listContentJobs() } };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
);

/** One ContentJob with its status, result and error (null when it is gone). */
export const getContentJobById = createServerFn({ method: "GET" })
  .validator((d: unknown) => d as { jobId: number })
  .handler(
    async ({ data }): Promise<ActionResult<{ job: ContentJobRow | null }>> => {
      await ensureInitialized();
      const user = await currentUser();
      if (!user) return { ok: false, error: "Not authenticated" };
      try {
        return { ok: true, data: { job: await getContentJob(data.jobId) } };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
  );
