/**
 * Autonoblog — one-time init. Ensures DB migrated + seeded before first use.
 * Operates on whichever backend the store selects (Postgres or SQLite).
 */
import { migrate } from "./store";
import { seed } from "./seed";
let initialized = false;
export async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  await migrate();
  await seed();
  initialized = true;
}
