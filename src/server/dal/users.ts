/**
 * Autonoblog — DAL: users (dashboard stats + lookup).
 */
import { all, get } from "../store";

export interface UserRow {
  id: number;
  email: string;
  display_name: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export async function getUserById(id: number): Promise<UserRow | undefined> {
  return get<UserRow>("SELECT * FROM users WHERE id = ?", id);
}

export interface UserDashboardStats {
  userId: number;
  blogCount: number;
  postCount: number;
}

export async function getDashboardStats(
  userId: number
): Promise<UserDashboardStats> {
  const blogs = await all<{ id: number }>(
    "SELECT b.id FROM blogs b JOIN blog_members bm ON bm.blog_id = b.id WHERE bm.user_id = ?",
    userId
  );
  let postCount = 0;
  if (blogs.length > 0) {
    const ids = blogs.map((b) => b.id);
    const row = await get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM posts WHERE blog_id IN (${ids
        .map(() => "?")
        .join(",")})`,
      ...ids
    );
    // Postgres returns COUNT(*) as bigint (a string) — coerce to a real number.
    postCount = Number(row?.n ?? 0) || 0;
  }
  return { userId, blogCount: blogs.length, postCount };
}
