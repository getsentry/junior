/**
 * Keep the `fetch` traffic of an eval process on the Roach proxy.
 *
 * `@sentry/roach/vitest` sets the proxy as the global `fetch` dispatcher.
 * Some clients give `fetch` their own undici `Agent`. `@vercel/sandbox`
 * does this. That agent ignores the proxy, so the request skips Roach, and
 * the CI network jail (`scripts/network-jail.sh`) refuses it.
 * `useGlobalDispatcherForFetch()` removes that agent, so the request uses
 * the global dispatcher.
 */

const MARK = Symbol.for("junior-evals.fetchUsesGlobalDispatcher");

type MarkedFetch = typeof fetch & { [MARK]?: true };

/**
 * Remove the caller's own dispatcher from every `fetch` of this process.
 * MSW also replaces `fetch` and restores it when it closes, so call this
 * after MSW starts. A second call does nothing.
 */
export function useGlobalDispatcherForFetch(): void {
  const current = globalThis.fetch as MarkedFetch;
  if (current[MARK]) return;
  const replacement: MarkedFetch = (input, init) => {
    if (!init || !("dispatcher" in init)) return current(input, init);
    const { dispatcher: _ignored, ...rest } = init as RequestInit & {
      dispatcher?: unknown;
    };
    return current(input, rest);
  };
  replacement[MARK] = true;
  globalThis.fetch = replacement;
}
