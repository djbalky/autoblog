/**
 * Autonoblog — server RPCs for Phase 1 (register, login, logout, dashboard).
 */

import { createServerFn } from "@tanstack/react-start";
import { registerUser, loginUser } from "../auth";
import type { PublicUser } from "../auth";
import {
  currentUser,
  setSessionCookie,
  clearSession,
} from "../auth-context";
import { ensureInitialized } from "../init";
import { getDashboardStats } from "../dal/users";
import { listBlogsForUser, listBlogCardsForUser } from "../dal/blogs";
import { logActivity } from "../dal/activity";
import { usingPostgres } from "../store";

interface Credentials {
  email: string;
  password: string;
  displayName?: string;
}

export interface ActionResult<T = unknown> {
  ok: boolean;
  error?: string;
  data?: T;
}

const asCredentials = (d: unknown) => d as Credentials;

// ---- Register -------------------------------------------------------------

export const registerAction = createServerFn({ method: "POST" })
  .validator(asCredentials)
  .handler(async ({ data }): Promise<ActionResult<{ user: PublicUser }>> => {
    await ensureInitialized();
    try {
      const { user, token } = await registerUser({
        email: data.email,
        password: data.password,
        displayName: data.displayName ?? "",
      });
      setSessionCookie(token);
      await logActivity({
        userId: user.id,
        action: "auth.register",
        detail: `Registered account ${user.email}`,
      });
      return { ok: true, data: { user } };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

// ---- Login ----------------------------------------------------------------

export const loginAction = createServerFn({ method: "POST" })
  .validator(asCredentials)
  .handler(async ({ data }): Promise<ActionResult<{ user: PublicUser }>> => {
    await ensureInitialized();
    try {
      const { user, token } = await loginUser(data.email, data.password);
      setSessionCookie(token);
      await logActivity({
        userId: user.id,
        action: "auth.login",
        detail: `Logged in ${user.email}`,
      });
      return { ok: true, data: { user } };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

// ---- Logout ---------------------------------------------------------------

export const logoutAction = createServerFn({ method: "POST" }).handler(
  async (): Promise<ActionResult> => {
    await clearSession();
    return { ok: true };
  }
);

// ---- Current user (for route guards / header) -----------------------------

export const currentUserAction = createServerFn().handler(
  async (): Promise<{ user: PublicUser | null }> => {
    await ensureInitialized();
    return { user: await currentUser() };
  }
);

// ---- Dashboard stats ------------------------------------------------------

export const dashboardStatsAction = createServerFn().handler(
  async (): Promise<{
    user: PublicUser;
    blogCount: number;
    postCount: number;
    /** Which storage backend the request actually hit (store.ts switch). */
    storage: "postgres" | "sqlite";
  }> => {
    await ensureInitialized();
    const user = await currentUser();
    if (!user) throw new Error("NOT_AUTHENTICATED");
    const { blogCount, postCount } = await getDashboardStats(user.id);
    return {
      user,
      blogCount,
      postCount,
      storage: usingPostgres() ? "postgres" : "sqlite",
    };
  }
);

export const myBlogsAction = createServerFn().handler(async () => {
  await ensureInitialized();
  const user = await currentUser();
  if (!user) throw new Error("NOT_AUTHENTICATED");
  return listBlogsForUser(user.id);
});

/**
 * Phase 3 — dashboard blog gallery.
 * Returns only the blogs the *current session user* is a member of
 * (blog_members scoping), each with real counters + blog_settings summary.
 */
export const myBlogCardsAction = createServerFn().handler(async () => {
  await ensureInitialized();
  const user = await currentUser();
  if (!user) throw new Error("NOT_AUTHENTICATED");
  return listBlogCardsForUser(user.id);
});
