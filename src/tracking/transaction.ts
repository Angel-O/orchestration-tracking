import { Database } from "bun:sqlite";
import { protectTrackerDatabaseFiles } from "./schema.js";

/** Immediate transaction and post-commit privacy protection for every store mutation. */
export function immediate<T>(db: Database, dataDir: string, callback: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    protectTrackerDatabaseFiles(dataDir);
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original transaction error.
    }
    throw error;
  }
}
