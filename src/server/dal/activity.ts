/**
 * Autonoblog — DAL: activity log + notifications.
 */
import { run, nowIso } from "../store";

export async function logActivity(input: {
  userId?: number | null;
  blogId?: number | null;
  action: string;
  entityType?: string;
  entityId?: number | null;
  detail?: string;
}): Promise<void> {
  await run(
    `INSERT INTO activity_logs
       (user_id, blog_id, action, entity_type, entity_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.userId ?? null,
    input.blogId ?? null,
    input.action,
    input.entityType ?? "",
    input.entityId ?? null,
    input.detail ?? "",
    nowIso()
  );
}

export async function createNotification(input: {
  userId: number;
  type?: string;
  title: string;
  body?: string;
}): Promise<void> {
  await run(
    `INSERT INTO notifications (user_id, type, title, body, is_read, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
    input.userId,
    input.type ?? "info",
    input.title,
    input.body ?? "",
    nowIso()
  );
}
