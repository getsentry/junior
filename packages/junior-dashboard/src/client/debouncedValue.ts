import { useEffect, useState } from "react";

/**
 * Return `value` once it stops changing for `delayMs`. Use it for search text
 * that is local state, so each keystroke does not send a request.
 */
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, value]);
  return debounced;
}
