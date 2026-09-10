/**
 * Answer records: the reply to a question the human asked, surfaced as its own
 * card so it is not buried under the output it arrived with (Lane D, captain
 * steer `answer-primitive`).
 *
 * Contract — `$FM_HOME/state/answers/*.json`, one record per file:
 *
 *     { "id": "…", "question": "…", "answer": "…", "ref": "…"?, "ts": "…" }
 *
 * firstmate owns writing these. helm only reads them, schema-validates field by
 * field (SPEC R3 — never parse prose), and renders them read-only. A record it
 * cannot validate is skipped and named on the console rather than guessed at,
 * so a contract drift is visible instead of silently mis-rendered.
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";

import type { HelmConfig } from "../config";
import { inboxItemId, type InboxAdapter, type InboxItem } from "../types";

/** How often the answers directory is re-read, alongside its file watcher. */
const POLL_MS = 5_000;

/**
 * One answer record.
 *
 * `id` is the per-occurrence natural key: a later answer to the same question
 * must arrive under a new id, or its card would stay suppressed forever by
 * answered history (captain decision `answered-history-unbounded-and-permanent`).
 */
export const answerRecordSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  answer: z.string().min(1),
  ref: z.string().min(1).optional(),
  ts: z.string().min(1),
});
export type AnswerRecord = z.infer<typeof answerRecordSchema>;

/** Validate one already-decoded answer record. */
export function parseAnswerRecord(value: unknown): AnswerRecord {
  return answerRecordSchema.parse(value);
}

/** Build the card for one answer record. */
export function answerItem(record: AnswerRecord, evidencePath: string): InboxItem {
  return {
    id: inboxItemId("answers", record.id),
    source: "answers",
    kind: "answer",
    // Not blocking — nothing is waiting on it — but the human asked for it, so
    // it must not sink into the fyi noise floor either.
    urgency: "attention",
    title: record.question,
    detail: record.answer,
    ref: record.ref,
    options: [],
    allowFreeform: false,
    // An answer is a report, not a question. There is nothing to reply to; the
    // human reads it and dismisses it.
    respond: { channel: "none" },
    evidence: [{ path: evidencePath }],
    state: "open",
    openedAt: record.ts,
  };
}

/**
 * Read every valid answer record in `dir`.
 *
 * A missing directory is normal — firstmate has simply not written one yet — so
 * it yields an empty set rather than an error.
 *
 * `onSkip` is called once per unreadable record. The adapter re-reads the whole
 * directory on every tick, so the caller dedupes: a permanently malformed file
 * must be reported, but not several times a minute forever.
 */
export function readAnswerRecords(
  dir: string,
  onSkip: (file: string, cause: unknown) => void = () => undefined,
): InboxItem[] {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  const items: InboxItem[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      items.push(answerItem(parseAnswerRecord(JSON.parse(readFileSync(path, "utf8"))), path));
    } catch (cause) {
      onSkip(basename(path), cause);
    }
  }
  return items;
}

/** Adapter over `$FM_HOME/state/answers`. */
export function createAnswerAdapter(cfg: HelmConfig): InboxAdapter {
  const dir = join(cfg.fmStateDir, "answers");
  return {
    id: "answers",
    async start(ctx) {
      let stopped = false;
      // One report per file per distinct fault: the directory is re-read every
      // tick, so an unfixed record would otherwise fill the log forever.
      const reported = new Map<string, string>();
      const refresh = (): void => {
        if (stopped) return;
        try {
          ctx.emit(
            readAnswerRecords(dir, (file, cause) => {
              const message = cause instanceof Error ? cause.message : String(cause);
              if (reported.get(file) === message) return;
              reported.set(file, message);
              console.error(`answers: ${file} is not a valid answer record: ${message}`);
            }),
          );
        } catch (cause) {
          console.error("answers: refresh failed", cause);
        }
      };
      const chokidar = await import("chokidar");
      const watcher = chokidar.default.watch(dir, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
      });
      const debounce = (): void => {
        setTimeout(refresh, 100);
      };
      watcher.on("add", debounce).on("change", debounce).on("unlink", debounce).on("addDir", debounce).on("unlinkDir", debounce);
      refresh();
      // The watcher alone cannot see a directory that does not exist yet, so a
      // poll carries the adapter until firstmate first writes one.
      const timer = setInterval(refresh, POLL_MS);
      return {
        [Symbol.dispose]() {
          stopped = true;
          clearInterval(timer);
          void watcher.close();
        },
      };
    },
  };
}
