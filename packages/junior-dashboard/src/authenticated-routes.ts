import type { PluginRouteMethod, User } from "@sentry/junior-plugin-api";

/** One host route that runs after dashboard user authentication. */
export type AuthenticatedRoute = {
  handler(request: Request, user: User): Promise<Response> | Response;
  method?: PluginRouteMethod | readonly PluginRouteMethod[];
  path: string;
};

function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** Return whether a request path matches one app-owned authenticated route. */
export function isAuthPath(
  pathname: string,
  routes: readonly AuthenticatedRoute[],
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
