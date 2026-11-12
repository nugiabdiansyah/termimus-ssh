/**
 * In-page handlers for the Android system Back button.
 *
 * A view with its own "one level up" (a settings section opened from the
 * section list, say) registers a handler while that level is showing. On
 * Back, `useBackButton` asks these, newest first, before falling back to
 * leaving the page. A handler returns `true` when it consumed the press.
 */

type BackHandler = () => boolean;

const handlers: BackHandler[] = [];

/** Register a handler; call the returned function to remove it. */
export function registerBackHandler(handler: BackHandler): () => void {
  handlers.push(handler);
  return () => {
    const index = handlers.lastIndexOf(handler);
    if (index !== -1) handlers.splice(index, 1);
  };
}

/** Offer a Back press to the registered handlers. True if one took it. */
export function runBackHandlers(): boolean {
  for (let i = handlers.length - 1; i >= 0; i--) {
    if (handlers[i]()) return true;
  }
  return false;
}
