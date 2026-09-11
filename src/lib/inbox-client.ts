/**
 * Browser-side inbox contracts: schema-validate SSE payloads and POST answers.
 *
 * Adapter text is untrusted input. Parsing is field-by-field so a drifted
 * event fails closed rather than being interpolated as markup or a shell string.
 */
import { z } from "zod";

import type { InboxItem, RespondAction } from "./types";

const inboxOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  hint: z.string().optional(),
});

const inboxEvidenceSchema = z.object({
  path: z.string(),
  line: z.number().int().optional(),
});

const inboxRespondSchema = z.object({
  channel: z.enum(["resolve-key", "captain-hold", "relay", "none"]),
  target: z.string().optional(),
  key: z.string().optional(),
  close: z.enum(["done", "release"]).optional(),
});

const inboxItemSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  kind: z.enum([
    "status-decision",
    "decision",
    "merge",
    "credential",
    "captain-held",
    "destructive",
    "irreversible",
    "security-sensitive",
    "blocker",
    "escalation",
    "review",
    "note",
    "answer",
    "ask",
    "custom",
  ]),
  urgency: z.enum(["blocking", "attention", "fyi"]),
  taskId: z.string().optional(),
  repo: z.string().optional(),
  title: z.string(),
  detail: z.string().optional(),
  about: z.string().optional(),
  ref: z.string().optional(),
  options: z.array(inboxOptionSchema),
  allowFreeform: z.boolean(),
  recommendValue: z.string().optional(),
  respond: inboxRespondSchema,
  evidence: z.array(inboxEvidenceSchema),
  state: z.enum(["open", "answered", "dismissed"]),
  openedAt: z.string(),
  answeredAt: z.string().optional(),
  answer: z.string().optional(),
});

const retractSchema = z.object({
  id: z.string().min(1),
});

/** Parse one SSE `item.upsert` payload. Returns null when the event is not an item. */
export function parseInboxItem(raw: string): InboxItem | null {
  try {
    const parsed = inboxItemSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Parse one SSE `item.retract` payload. */
export function parseInboxRetractId(raw: string): string | null {
  try {
    const parsed = retractSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data.id : null;
  } catch {
    return null;
  }
}

export interface InboxRespondClientResult {
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * Deliver one card answer through the inbox respond endpoint.
 *
 * Sends either `value` or `text`, never both. The server enforces the card
 * contract and the operator gate.
 */
export async function submitInboxResponse(
  id: string,
  action: RespondAction,
): Promise<InboxRespondClientResult> {
  const body =
    action.value !== undefined ? { value: action.value } : { text: action.text };
  return postInbox(`/api/inbox/${encodeURIComponent(id)}/respond`, body, "respond");
}

/**
 * Dismiss a card without answering it.
 *
 * Local to helm: it closes the card on the operator's own board and calls no
 * firstmate seam, so the underlying condition is untouched.
 */
export async function dismissInboxItem(id: string): Promise<InboxRespondClientResult> {
  return postInbox(`/api/inbox/${encodeURIComponent(id)}/dismiss`, {}, "dismiss");
}

async function postInbox(
  path: string,
  body: unknown,
  label: string,
): Promise<InboxRespondClientResult> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (response.ok) return { ok: true };
    const error =
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof (parsed as { error: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : `${label} failed (${response.status})`;
    return { ok: false, error };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}
