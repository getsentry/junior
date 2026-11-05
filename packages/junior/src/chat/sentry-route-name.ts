import type { MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import * as Sentry from "@/chat/sentry";

type SentrySpan = Parameters<
  NonNullable<Sentry.NodeOptions["beforeSendSpan"]>
>[0];

// The core app calls the dashboard app, and the dashboard app calls plugin
// apps, through `fetch()`. The Hono integration renames the request span as
// each app returns, so the outermost app wins: a dashboard request is
// `GET /api/conversations/*` and sandbox egress is `GET /*`. This attribute
// keeps the inner route until `promoteHttpRouteName` restores it on the sent
// segment and removes it.
const HTTP_ROUTE_ATTRIBUTE = "app.http.route";
// Hono marks the handler that `app.route()` wraps with the original handler.
const COMPOSED_HANDLER = "__COMPOSED_HANDLER";

/**
 * Name the current request span after a route pattern. Spans that end during
 * the request take this name as their segment name.
 */
export function nameRequestRoute(method: string, route: string): void {
  const activeSpan = Sentry.getActiveSpan();
  if (!activeSpan) return;
  const rootSpan = Sentry.getRootSpan(activeSpan);
  const name = `${method} ${route}`;
  Sentry.updateSpanName(rootSpan, name);
  rootSpan.setAttribute(HTTP_ROUTE_ATTRIBUTE, route);
  Sentry.getIsolationScope().setTransactionName(name);
}

function isMiddleware(handler: unknown): boolean {
  if (typeof handler !== "function") return false;
  const composed =
    COMPOSED_HANDLER in handler ? handler[COMPOSED_HANDLER] : undefined;
  return (typeof composed === "function" ? composed : handler).length >= 2;
}

/**
 * Name the request span after the first route handler that matches in this
 * app. Register it first in an app that another app calls through `fetch()`.
 */
export function routeNameMiddleware(): MiddlewareHandler {
  return async function routeName(c, next) {
    // Hono runs matched handlers in order and the first handler returns the
    // response, so it is the route that serves the request.
    const route = matchedRoutes(c).find(
      ({ handler }) => !isMiddleware(handler),
    );
    if (route) nameRequestRoute(c.req.method, route.path);
    await next();
  };
}

/**
 * Restore the inner route name on a sent `http.server` segment. The outer
 * Hono app renames the span to its own pattern after the inner app returns.
 */
export function promoteHttpRouteName(span: SentrySpan): void {
  const { attributes } = span;
  const route = attributes[HTTP_ROUTE_ATTRIBUTE];
  const method = attributes["http.request.method"];
  if (!span.is_segment || attributes["sentry.op"] !== "http.server") return;
  if (typeof route !== "string" || typeof method !== "string") return;
  const name = `${method} ${route}`;
  span.name = name;
  attributes["http.route"] = route;
  attributes["sentry.segment.name"] = name;
  delete attributes[HTTP_ROUTE_ATTRIBUTE];
}
