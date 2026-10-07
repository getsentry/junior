/**
 * Make every `fetch` of an eval process use the global dispatcher.
 *
 * Some clients give `fetch` their own undici `Agent`. `@vercel/sandbox`
 * does this. That agent ignores the proxy settings of the run, so the
 * request skips the recording proxy, and the CI network jail
 * (`scripts/network-jail.sh`) refuses it. Without its own agent, the
 * request uses the global dispatcher, which sends it through the proxy.
 *
 * MSW also replaces `fetch` and restores it when it closes, so call this
 * after MSW starts. A second call does nothing.
 */
const MARK = Symbol.for("junior-evals.fetchUsesGlobalDispatcher");

type MarkedFetch = typeof fetch & { [MARK]?: true };

/** Remove the caller's own dispatcher from every `fetch` of this process. */
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
