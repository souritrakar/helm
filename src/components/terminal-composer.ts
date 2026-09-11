"use client";

/**
 * The one-way channel from an inbox card to the terminal composer.
 *
 * An inbox card and the composer sit in different branches of the tree, and on
 * a phone the terminal is folded away entirely — so the composer is often not
 * mounted when the human taps "add to terminal". A module-level channel keeps
 * that a two-line call from the card instead of threading a callback through
 * the panel, the list, and every card.
 *
 * Two signals travel it:
 *
 * - **reveal** — the shell un-folds the terminal, which mounts the composer.
 * - **attach** — the composer attaches the card to the message being written.
 *
 * A context published while no composer is mounted is queued, not dropped: the
 * reveal that accompanies it is what mounts the subscriber, so the attach
 * always arrives second.
 */

/**
 * One card, attached to the message the human is writing.
 *
 * `text` is the full one-line block that will travel to the pane; `label` is
 * only what the chip says, so the composer can name the card in a few words
 * without the human having to read 700 characters of it back.
 */
export interface TerminalContext {
  readonly label: string;
  readonly text: string;
}

type AttachListener = (context: TerminalContext) => void;

/** At most one composer exists, so the newest subscriber owns the channel. */
let composer: AttachListener | null = null;
let queue: TerminalContext[] = [];
const revealListeners = new Set<() => void>();

/**
 * Ask the shell to show the terminal, then attach `context` to the draft.
 *
 * Reveal is published first so a folded terminal mounts its composer before the
 * context is delivered.
 */
export function addToTerminalContext(context: TerminalContext): void {
  for (const listener of revealListeners) listener();
  if (composer === null) {
    queue.push(context);
    return;
  }
  composer(context);
}

/**
 * Subscribe the composer. Drains anything queued while it was unmounted.
 *
 * Call from an effect: the drain invokes `listener` synchronously.
 */
export function onTerminalContext(listener: AttachListener): () => void {
  composer = listener;
  const pending = queue;
  queue = [];
  for (const context of pending) listener(context);
  return () => {
    if (composer === listener) composer = null;
  };
}

/** Subscribe the shell's "show the terminal" handler. */
export function onTerminalReveal(listener: () => void): () => void {
  revealListeners.add(listener);
  return () => {
    revealListeners.delete(listener);
  };
}
