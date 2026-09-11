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
 * - **append** — the composer appends the block to the human's draft.
 *
 * A block published while no composer is mounted is queued, not dropped: the
 * reveal that accompanies it is what mounts the subscriber, so the append
 * always arrives second.
 */

type AppendListener = (block: string) => void;

/** At most one composer exists, so the newest subscriber owns the channel. */
let composer: AppendListener | null = null;
let queue: string[] = [];
const revealListeners = new Set<() => void>();

/**
 * Ask the shell to show the terminal, then put `block` in the composer draft.
 *
 * Reveal is published first so a folded terminal mounts its composer before the
 * block is delivered.
 */
export function addToTerminalContext(block: string): void {
  for (const listener of revealListeners) listener();
  if (composer === null) {
    queue.push(block);
    return;
  }
  composer(block);
}

/**
 * Subscribe the composer. Drains anything queued while it was unmounted.
 *
 * Call from an effect: the drain invokes `listener` synchronously.
 */
export function onTerminalContext(listener: AppendListener): () => void {
  composer = listener;
  const pending = queue;
  queue = [];
  for (const block of pending) listener(block);
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
