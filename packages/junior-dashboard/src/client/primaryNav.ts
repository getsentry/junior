import type { PluginUserPageLink } from "@sentry/junior-plugin-api";

import type { DashboardHeaderNavItem } from "./components/layout/DashboardHeader";
import { pluginUserPagePath } from "./pages/user/PluginUserPage";

const AUTH_PRIMARY_NAV_PREFIXES = [
  "/tasks",
  "/memories",
  "/settings",
  "/plugins/",
] as const;

/** True when the path is only available to a signed-in viewer. */
export function isAuthPrimaryNavPath(pathname: string): boolean {
  return AUTH_PRIMARY_NAV_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** Build the signed-in primary nav, holding auth slots while shell data loads. */
export function buildPrimaryNavItems(input: {
  loading: boolean;
  loggedIn: boolean;
  pathname: string;
  primaryUserPages: PluginUserPageLink[];
  userPagesPending: boolean;
}): DashboardHeaderNavItem[] {
  const memoryNavPage = input.primaryUserPages.find(
    (page) => page.pluginName === "memory" && page.id === "memories",
  );
  const otherPrimaryUserPages = input.primaryUserPages.filter(
    (page) => !(page.pluginName === "memory" && page.id === "memories"),
  );
  // Auth-only routes already imply the signed-in primary nav. Hold Tasks and
  // Memories slots while core/user-pages catch up so the header does not jump.
  const reserveAuthPrimaryNav =
    input.loading && isAuthPrimaryNavPath(input.pathname);
  const showTasksNav = input.loggedIn || reserveAuthPrimaryNav;
  const showMemoriesNav =
    Boolean(memoryNavPage) ||
    reserveAuthPrimaryNav ||
    (input.loggedIn && input.userPagesPending);

  return [
    { key: "code", label: "Code", to: "/code" },
    ...(showTasksNav ? [{ key: "tasks", label: "Tasks", to: "/tasks" }] : []),
    ...(showMemoriesNav
      ? [
          {
            key: "memory:memories",
            label: memoryNavPage?.label ?? "Memories",
            to: pluginUserPagePath("memory", "memories"),
          },
        ]
      : []),
    ...otherPrimaryUserPages.map((page) => ({
      key: `${page.pluginName}:${page.id}`,
      label: page.label,
      to: pluginUserPagePath(page.pluginName, page.id),
    })),
    { key: "system", label: "System", to: "/system" },
  ];
}
