/**
 * Paths under helm's own state directory (`~/.local/state/helm` by default).
 *
 * This tree is NOT `$FM_HOME`. helm may write answered-history and the audit
 * log here; it must never write under `$FM_HOME` (AGENTS.md hard rule 1).
 */
import { join } from "node:path";

/** Answered / dismissed history so a restart does not resurrect handled cards. */
export function historyPath(helmStateDir: string): string {
  return join(helmStateDir, "inbox-history.json");
}

/** Append-only audit log of every response attempt (SPEC §5.5). */
export function auditLogPath(helmStateDir: string): string {
  return join(helmStateDir, "actions.jsonl");
}
