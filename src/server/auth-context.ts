/**
 * Autonoblog — request-scoped auth helpers (cookies + route guards).
 *
 * Only callable inside server functions / route loaders (request scope).
 */
import { redirect } from "@tanstack/react-router";
import {
  getCookie,
  setCookie,
  deleteCookie,
} from "@tanstack/react-start/server";
import { getUserByToken, destroySession } from "./auth";
import type { PublicUser } from "./auth";
export const SESSION_COOKIE = "autonoblog_session";
const ONE_YEAR = 60 * 60 * 24 * 365;
/** Read the session cookie -> authenticated user or null. */
export async function currentUser(): Promise<PublicUser | null> {
  return getUserByToken(getCookie(SESSION_COOKIE));
}
/**
 * Guard helper for protected server functions/loaders. Redirects to /login
 * when there is no valid session.
 */
export async function requireUser(): Promise<PublicUser> {
  const user = await currentUser();
  if (!user) {
    throw redirect({ href: "/login" });
  }
  return user;
}
/** A variant that returns null instead of redirecting (for optional auth). */
export async function optionalUser(): Promise<PublicUser | null> {
  return currentUser();
}
/** Set the session cookie on the response. */
export function setSessionCookie(token: string): void {
  setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: ONE_YEAR,
  });
}
/** Clear the session cookie and destroy the server-side session. */
export async function clearSession(): Promise<void> {
  const token = getCookie(SESSION_COOKIE);
  if (token) await destroySession(token);
  deleteCookie(SESSION_COOKIE, { path: "/" });
}
export type { PublicUser };
