import type { JuniorAuthenticatedRoute } from "@sentry/junior";

function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** Return whether a request path matches one app-owned authenticated route. */
export function isAuthenticatedPath(
  pathname: string,
  routes: readonly JuniorAuthenticatedRoute[],
): boolean {
  const requestSegments = segments(pathname);
  return routes.some((route) => {
    const routeSegments = segments(route.path);
    for (let index = 0; index < routeSegments.length; index += 1) {
      const pattern = routeSegments[index];
      if (pattern === "*") return true;
      const value = requestSegments[index];
      if (!value || (pattern !== value && !pattern.startsWith(":"))) {
        return false;
      }
    }
    return routeSegments.length === requestSegments.length;
  });
}
