import { Suspense, useLayoutEffect, type ReactNode } from "react";
import {
  createRoutesFromChildren,
  matchRoutes,
  useLocation,
  useRoutes,
  type RouteMatch,
} from "react-router";

import { nameRouteSpan } from "./sentry";

function routePattern(matches: RouteMatch[]): string {
  let pattern = "";
  for (const { route } of matches) {
    if (!route.path) continue;
    pattern = route.path.startsWith("/")
      ? route.path
      : `${pattern.replace(/\/\*?$/, "")}/${route.path}`;
  }
  return pattern || "/";
}

/**
 * Render `<Route>` children like `<Routes>`, and name the open pageload or
 * navigation span after the route pattern that matched, such as
 * `/conversations/:conversationId`. Lazy pages show `fallback` while their
 * code loads.
 */
export function TracedRoutes(props: {
  children: ReactNode;
  fallback: ReactNode;
}) {
  const location = useLocation();
  const routes = createRoutesFromChildren(props.children);
  const element = useRoutes(routes, location);
  const matches = matchRoutes(routes, location);
  const pattern = matches ? routePattern(matches) : undefined;
  // A layout effect runs before the passive effects of the page, so spans
  // that the page ends in its first effects get the route name too.
  useLayoutEffect(() => {
    if (pattern) nameRouteSpan(pattern);
  }, [location.key, pattern]);
  return <Suspense fallback={props.fallback}>{element}</Suspense>;
}
