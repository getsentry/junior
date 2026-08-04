export const dashboardRoutes = {
  conversation: { path: "/conversations/:conversationId" },
  conversations: { path: "/conversations" },
  dev: { componentGallery: true, path: "/dev/*" },
  fallback: { path: "*" },
  home: { path: "/" },
  location: { path: "/locations/:locationId" },
  locations: { path: "/locations" },
  person: { path: "/people/:email" },
  people: { path: "/people" },
  pluginPage: { path: "/plugins/:pluginName/:pageId/*" },
  settingsApiTokens: { path: "/settings/api-tokens" },
  system: { path: "/system/*" },
  systemLocation: { path: "/system/locations/:locationId" },
  systemLocations: { path: "/system/locations" },
  systemPeople: { path: "/system/people" },
  tasks: { path: "/tasks" },
} as const;

interface DashboardPagePath {
  nested?: boolean;
  path: string;
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 1 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function normalizePath(path: string | undefined, fallback: string): string {
  const value = path?.trim() || fallback;
  const withSlash = value.startsWith("/") ? value : `/${value}`;
  return stripTrailingSlashes(withSlash);
}

function routeRoot(path: string): DashboardPagePath | undefined {
  if (path === "*") {
    return undefined;
  }
  const segments = path.split("/").filter(Boolean);
  const dynamicIndex = segments.findIndex(
    (segment) => segment === "*" || segment.startsWith(":"),
  );
  const rootSegments =
    dynamicIndex === -1 ? segments : segments.slice(0, dynamicIndex);
  return {
    nested: dynamicIndex !== -1 || undefined,
    path: rootSegments.length === 0 ? "/" : `/${rootSegments.join("/")}`,
  };
}

function withBasePath(basePath: string, path: string): string {
  if (basePath === "/") {
    return path;
  }
  return path === "/" ? basePath : `${basePath}${path}`;
}

/** Resolve browser page paths the dashboard server must render. */
export function dashboardPagePaths(
  basePath: string,
  options: { componentGallery?: boolean } = {},
): DashboardPagePath[] {
  const merged = new Map<string, DashboardPagePath>();
  for (const route of Object.values(dashboardRoutes)) {
    if ("componentGallery" in route && !options.componentGallery) {
      continue;
    }
    const root = routeRoot(route.path);
    if (!root) {
      continue;
    }
    const current = merged.get(root.path);
    merged.set(root.path, {
      nested: current?.nested || root.nested || undefined,
      path: root.path,
    });
  }

  const roots = [...merged.values()].filter(
    (candidate) =>
      ![...merged.values()].some(
        (route) =>
          route.nested &&
          route.path !== candidate.path &&
          candidate.path.startsWith(`${route.path}/`),
      ),
  );
  return roots.map((route) => ({
    ...route,
    path: withBasePath(basePath, route.path),
  }));
}

/** List every path core must forward to the dashboard app. */
export function dashboardRoutePaths(options: {
  authPath?: string;
  basePath?: string;
  componentGallery?: boolean;
}): string[] {
  const basePath = normalizePath(options.basePath, "/");
  const authPath = normalizePath(options.authPath, "/api/auth");
  const pagePaths = dashboardPagePaths(basePath, options).flatMap((route) =>
    route.nested ? [route.path, `${route.path}/*`] : [route.path],
  );
  const loginPath = basePath === "/" ? "/auth/login" : `${basePath}/auth/login`;

  return [
    ...pagePaths,
    "/favicon.ico",
    "/_junior/dashboard/avatar.png",
    "/_junior/dashboard/client.js",
    loginPath,
    "/api/health",
    "/api/runtime",
    "/api/plugins",
    "/api/plugins/*",
    "/api/plugin-reports",
    "/api/user-pages",
    "/api/user-pages/*",
    "/api/tasks",
    "/api/tasks/*",
    "/api/skills",
    "/api/stats",
    "/api/conversations",
    "/api/conversations/*",
    "/api/locations",
    "/api/locations/*",
    "/api/people",
    "/api/people/*",
    "/api/personal-tokens",
    "/api/personal-tokens/*",
    "/api/config",
    "/api/me",
    authPath,
    `${authPath}/*`,
  ];
}
