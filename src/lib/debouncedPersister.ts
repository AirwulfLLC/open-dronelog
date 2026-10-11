/**
 * Debounced, strictly-ordered persister: coalesces rapid edits (per-keystroke)
 * into one write and chains writes so a slow earlier request can never land
 * after (and clobber) a newer one.
 */
export function makeDebouncedPersister<T>(
  write: (payload: T) => Promise<void>,
  label: string,
  delayMs = 400,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let pending: T | null = null;
  const flush = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending !== null) {
      const p = pending;
      pending = null;
      chain = chain
        .then(() => write(p))
        .catch((e) => console.error(`Failed to persist ${label}:`, e));
    }
    return chain;
  };
  return {
    schedule(payload: T) {
      pending = payload;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    /** Write any pending payload now; resolves once every queued write settled. */
    flush,
  };
}
