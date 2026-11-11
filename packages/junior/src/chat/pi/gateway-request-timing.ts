import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import * as Sentry from "@/chat/sentry";

// The fields of undici diagnostics channel messages that this module reads.
// Node's bundled fetch publishes them; see undici `docs/api/DiagnosticsChannel.md`.
type UndiciRequest = { origin?: unknown; contentLength?: unknown };
type ConnectParams = { hostname?: unknown; port?: unknown };

type RequestTiming = {
  span: Sentry.Span;
  createdAtMs: number;
  sendHeadersAtMs?: number;
  bodySentAtMs?: number;
};

// Phase attributes of one attempt. A retry clears them, so the span keeps
// the timings of the last attempt only.
const PHASE_ATTRIBUTES = [
  "app.ai.http.queue_ms",
  "app.ai.http.connection_reused",
  "app.ai.http.connect_ms",
  "app.ai.http.body_send_ms",
  "app.ai.http.response_wait_ms",
  "http.request.body.size",
] as const;

function elapsedMs(fromMs: number, toMs: number): number {
  return Math.round(toMs - fromMs);
}

function connectKey(params: ConnectParams | undefined): string {
  return `${String(params?.hostname)}:${String(params?.port)}`;
}

// The model request runs inside its `gen_ai.chat` span, and that span names
// the gateway host in `server.address`. Other requests are ignored.
function gatewayChatSpan(request: UndiciRequest): Sentry.Span | undefined {
  const span = Sentry.getActiveSpan();
  if (!span || typeof request.origin !== "string") {
    return undefined;
  }
  const { attributes } = Sentry.spanToJSON(span);
  if (attributes["sentry.op"] !== "gen_ai.chat") {
    return undefined;
  }
  const host = URL.parse(request.origin)?.hostname;
  return host && host === attributes["server.address"] ? span : undefined;
}

// Handlers that split the time before the gateway sees a request into
// Junior-side phases (pool queue, connect, body upload) and the wait for
// response headers.
function createGatewayRequestTimingHandlers(): Record<
  string,
  (message: unknown) => void
> {
  const now = () => performance.now();
  const requests = new WeakMap<object, RequestTiming>();
  const attempts = new WeakMap<Sentry.Span, number>();
  const usedSockets = new WeakSet<object>();
  const connectMsBySocket = new WeakMap<object, number>();
  const pendingConnects = new Map<string, number[]>();

  // Connect events carry no request or socket id. A connect time is only
  // known when one connect to the host was pending. Each outcome clears the
  // host, so concurrent or dropped connects record nothing and leave no
  // stale start.
  const takePendingConnect = (key: string): number | undefined => {
    const starts = pendingConnects.get(key);
    pendingConnects.delete(key);
    return starts?.length === 1 ? starts[0] : undefined;
  };

  return {
    "undici:request:create": (message) => {
      const { request } = message as { request: UndiciRequest };
      const span = gatewayChatSpan(request);
      if (!span) {
        return;
      }
      const attempt = (attempts.get(span) ?? 0) + 1;
      attempts.set(span, attempt);
      requests.set(request, { span, createdAtMs: now() });
      if (attempt > 1) {
        for (const key of PHASE_ATTRIBUTES) {
          span.setAttribute(key, undefined);
        }
      }
      span.setAttribute("app.ai.http.attempt_count", attempt);
      if (typeof request.contentLength === "number") {
        span.setAttribute("http.request.body.size", request.contentLength);
      }
    },
    "undici:client:beforeConnect": (message) => {
      const { connectParams } = message as { connectParams?: ConnectParams };
      const key = connectKey(connectParams);
      pendingConnects.set(key, [...(pendingConnects.get(key) ?? []), now()]);
    },
    "undici:client:connected": (message) => {
      const { connectParams, socket } = message as {
        connectParams?: ConnectParams;
        socket: object;
      };
      const startedAtMs = takePendingConnect(connectKey(connectParams));
      if (startedAtMs !== undefined) {
        connectMsBySocket.set(socket, elapsedMs(startedAtMs, now()));
      }
    },
    "undici:client:connectError": (message) => {
      const { connectParams } = message as { connectParams?: ConnectParams };
      takePendingConnect(connectKey(connectParams));
    },
    "undici:client:sendHeaders": (message) => {
      const { request, socket } = message as {
        request: object;
        socket: object;
      };
      const timing = requests.get(request);
      if (!timing) {
        return;
      }
      timing.sendHeadersAtMs = now();
      const reused = usedSockets.has(socket);
      usedSockets.add(socket);
      timing.span.setAttribute(
        "app.ai.http.queue_ms",
        elapsedMs(timing.createdAtMs, timing.sendHeadersAtMs),
      );
      timing.span.setAttribute("app.ai.http.connection_reused", reused);
      const connectMs = reused ? undefined : connectMsBySocket.get(socket);
      if (connectMs !== undefined) {
        timing.span.setAttribute("app.ai.http.connect_ms", connectMs);
      }
    },
    "undici:request:bodySent": (message) => {
      const { request } = message as { request: object };
      const timing = requests.get(request);
      if (!timing || timing.sendHeadersAtMs === undefined) {
        return;
      }
      timing.bodySentAtMs = now();
      timing.span.setAttribute(
        "app.ai.http.body_send_ms",
        elapsedMs(timing.sendHeadersAtMs, timing.bodySentAtMs),
      );
    },
    "undici:request:headers": (message) => {
      const { request } = message as { request: object };
      const timing = requests.get(request);
      if (!timing || timing.bodySentAtMs === undefined) {
        return;
      }
      timing.span.setAttribute(
        "app.ai.http.response_wait_ms",
        elapsedMs(timing.bodySentAtMs, now()),
      );
    },
  };
}

/**
 * Subscribes to undici's diagnostics channels and writes the HTTP phases of
 * AI Gateway model requests onto their `gen_ai.chat` span. Telemetry must not
 * fail a request, so handler errors are dropped. Returns a function that
 * removes the subscriptions.
 *
 * To find where time went before the gateway saw a request, get the gateway
 * latency for `gen_ai.response.id` from the AI Gateway generation API, then
 * compare the phases:
 * - High `queue_ms` on a reused socket, or high
 *   `app.ai.event_loop.utilization`: the process was busy or the pool was
 *   full. With a new socket, `queue_ms` includes the connect time.
 * - High `connect_ms`: DNS, TCP, or TLS was slow. It is best effort and is
 *   absent on a reused socket.
 * - High `body_send_ms`: the upload was slow.
 * - `response_wait_ms` much larger than the gateway time to first token,
 *   with small Junior phases: the delay was in the network or at the Vercel
 *   edge. The gateway sends headers with the first token. Give Vercel
 *   `app.ai.gateway.vercel_id`.
 * - The same `service.instance.id` on more than one slow call: they shared
 *   one process.
 */
export function subscribeGatewayRequestTiming(): () => void {
  const handlers = Object.entries(createGatewayRequestTimingHandlers()).map(
    ([name, handler]) =>
      [
        name,
        (message: unknown) => {
          try {
            handler(message);
          } catch {
            // Diagnostic only.
          }
        },
      ] as const,
  );
  for (const [name, handler] of handlers) {
    subscribe(name, handler);
  }
  return () => {
    for (const [name, handler] of handlers) {
      unsubscribe(name, handler);
    }
  };
}
