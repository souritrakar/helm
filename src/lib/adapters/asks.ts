/**
 * Ask records: a question firstmate is putting TO the captain — the inverse of
 * the answer primitive.
 *
 * Contract — `$FM_HOME/state/asks/*.json`, one record per file:
 *
 *     { "id": "…", "question": "…", "context": "…", "options": ["…"]?,
 *       "ref": "…"?, "ts": "…" }
 *
 * firstmate owns writing these; helm only READS them and relays the captain's
 * reply into the firstmate pane. Nothing here writes under `$FM_HOME`.
 *
 * An `options` entry is BOTH the button label and the answer relayed verbatim.
 * helm invents no answer vocabulary (SPEC R5): the captain picks a word
 * firstmate itself wrote, or types their own.
 *
 * A record helm cannot validate is skipped and named on the console rather than
 * guessed at, so a contract drift is visible instead of silently mis-rendered.
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";

import type { HelmConfig } from "../config";
import { inboxItemId, type InboxAdapter, type InboxItem, type InboxRespondSpec } from "../types";
import { relay, type StateAdapterDeps } from "./state";

/** How often the asks directory is re-read, alongside its file watcher. */
const POLL_MS = 5_000;

/**
 * One question awaiting the captain.
 *
 * `id` is the per-occurrence natural key: asking the same question again must
 * arrive under a new id, or answered history would suppress the second card
 * forever (captain decision `answered-history-unbounded-and-permanent`).
 */
export const askRecordSchema = z.object({
  id: z.string().min(1).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: "id must not contain tab, newline, or control characters",
  }),
  question: z.string().min(1),
  context: z.string().min(1),
  options: z.array(z.string().min(1).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: "option must not contain tab, newline, or control characters",
  })).optional(),
  ref: z.string().min(1).optional(),
  ts: z.string().min(1),
});
export type AskRecord = z.infer<typeof askRecordSchema>;

/** Validate one already-decoded ask record. */
export function parseAskRecord(value: unknown): AskRecord {
  return askRecordSchema.parse(value);
}

/**
 * Build the card for one ask record.
 *
 * `respond` is passed in rather than derived, because a relay card is only
 * answerable while a firstmate pane is reachable — see {@link relay}.
 */
export function askItem(
  record: AskRecord,
  evidencePath: string,
  respond: InboxRespondSpec,
): InboxItem {
  return {
    id: inboxItemId("asks", record.id),
    source: "asks",
    kind: "ask",
    // firstmate is waiting on the reply, so the question blocks work the same
    // way a decision does. That is what earns it a notification.
    urgency: "blocking",
    title: record.question,
    detail: record.context,
    ref: record.ref,
    options: (record.options ?? []).map((option) => ({ value: option, label: option })),
    // Always: a question deserves a nuanced reply even when firstmate offered
    // shortcuts, and every answer takes the same relay path either way.
    allowFreeform: true,
    respond,
    evidence: [{ path: evidencePath }],
    state: "open",
    openedAt: record.ts,
  };
}

/**
 * Read every valid ask record in `dir`.
 *
 * A missing directory is normal — firstmate has simply not asked anything yet —
 * so it yields an empty set rather than an error.
 *
 * `onSkip` is called once per unreadable record. The adapter re-reads the whole
 * directory on every tick, so the caller dedupes.
 */
export function readAskRecords(
  dir: string,
  respond: InboxRespondSpec,
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
      items.push(askItem(parseAskRecord(JSON.parse(readFileSync(path, "utf8"))), path, respond));
    } catch (cause) {
      onSkip(basename(path), cause);
    }
  }
  return items;
}

/** Adapter over `$FM_HOME/state/asks`. */
export function createAskAdapter(cfg: HelmConfig, deps: StateAdapterDeps): InboxAdapter {
  const dir = join(cfg.fmStateDir, "asks");
  return {
    id: "asks",
    async start(ctx) {
      let stopped = false;
      // One report per file per distinct fault: the directory is re-read every
      // tick, so an unfixed record would otherwise fill the log forever.
      const reported = new Map<string, string>();
      const refresh = (): void => {
        if (stopped) return;
        try {
          // Resolved per tick, never once: the firstmate pane is discovered
          // after start(), and a card pinned to `channel: "none"` would render
          // its answer control dead for the life of the process.
          const respond = relay(deps);
          ctx.emit(
            readAskRecords(dir, respond, (file, cause) => {
              const message = cause instanceof Error ? cause.message : String(cause);
              if (reported.get(file) === message) return;
              reported.set(file, message);
              console.error(`asks: ${file} is not a valid ask record: ${message}`);
            }),
          );
        } catch (cause) {
          console.error("asks: refresh failed", cause);
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
      // poll carries the adapter until firstmate first writes one. It is also
      // what picks up a relay target that arrived after the last file change.
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
