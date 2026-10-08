/**
 * Send the `fetch` traffic of an eval process through the recording proxy.
 *
 * Node 24 sends `fetch` through the proxy variables that a process has at
 * startup (`NODE_USE_ENV_PROXY`). A process that started before them, such
 * as the main vitest process, sets the dispatcher itself.
 *
 * Some clients give `fetch` their own undici `Agent`. `@vercel/sandbox`
 * does this. That agent ignores the proxy, so the request skips the
 * recording proxy, and the CI network jail (`scripts/network-jail.sh`)
 * refuses it. `useGlobalDispatcherForFetch()` removes that agent, so the
 * request uses the global dispatcher.
 */
import { EnvHttpProxyAgent } from "undici";
import { NO_PROXY } from "./recording-rules";
import type { RecordingProxyAddress } from "./recording-proxy/types";

/** Create a `fetch` dispatcher that sends requests through the proxy. */
export function createProxyDispatcher(
  proxy: Pick<RecordingProxyAddress, "caCert" | "url">,
): EnvHttpProxyAgent {
  return new EnvHttpProxyAgent({
    httpProxy: proxy.url,
    httpsProxy: proxy.url,
    noProxy: NO_PROXY,
    requestTls: { ca: proxy.caCert },
  });
}

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
