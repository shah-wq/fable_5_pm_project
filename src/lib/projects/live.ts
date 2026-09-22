/**
 * "A project just moved" — told to every other tab in this browser, so the
 * Pipeline and Deals boards open side by side agree the moment either changes,
 * rather than at their next poll.
 *
 * A BroadcastChannel reaches the same person's other tabs only. Somebody else's
 * move reaches a board through its poll; this is what makes the common case —
 * one person with both boards open — immediate.
 *
 * Client-only, and it fails quietly: a browser without BroadcastChannel still
 * gets the poll, which is the whole of what it had before.
 */
const CHANNEL = 'solarflow:projects';

export function announceProjectsChanged(): void {
  try {
    const bc = new BroadcastChannel(CHANNEL);
    bc.postMessage({ at: Date.now() });
    bc.close();
  } catch {
    // No BroadcastChannel: the other boards catch up on their poll.
  }
}

/** Call `fn` whenever another tab announces a move. Returns the unsubscribe. */
export function onProjectsChanged(fn: () => void): () => void {
  try {
    const bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = () => fn();
    return () => bc.close();
  } catch {
    return () => undefined;
  }
}
