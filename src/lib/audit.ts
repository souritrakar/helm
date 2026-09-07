/**
 * Append-only audit log for every response attempt.
 *
 * Path: `$HELM_STATE_DIR/actions.jsonl` (default `~/.local/state/helm/actions.jsonl`).
 * Successes and failures are both recorded so a disputed action is always
 * reconstructable (SPEC §5.5, AC 12).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { auditLogPath } from "./paths";
import type { RespondAction, RespondChannel, RespondResult } from "./types";

/** One line in the audit log. */
export interface AuditEntry {
  readonly at: string;
  readonly itemId: string;
  readonly channel: RespondChannel;
  readonly action: RespondAction;
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ok: boolean;
  readonly error?: string;
}

export interface AuditWriter {
  append(entry: AuditEntry): void;
}

/** Build an audit entry from a respond attempt. */
export function auditEntryFromResult(
  itemId: string,
  action: RespondAction,
  result: RespondResult,
): AuditEntry {
  return {
    at: result.at,
    itemId,
    channel: result.channel,
    action,
    argv: result.argv,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    ok: result.ok,
    ...(result.ok ? {} : { error: result.error }),
  };
}

/**
 * File-backed audit writer. Creates the parent directory on first write.
 *
 * Writes are synchronous appends: a crash mid-response must still leave the
 * attempt on disk when the process reached the write.
 */
export function createFileAuditWriter(helmStateDir: string): AuditWriter {
  const path = auditLogPath(helmStateDir);
  return {
    append(entry: AuditEntry): void {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
    },
  };
}

/** In-memory audit writer for tests. */
export function createMemoryAuditWriter(): AuditWriter & { readonly entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    append(entry: AuditEntry): void {
      entries.push(entry);
    },
  };
}
