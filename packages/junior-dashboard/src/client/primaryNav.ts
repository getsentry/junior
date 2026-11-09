import type { PluginUserPageLink } from "@sentry/junior-plugin-api";

import type { DashboardHeaderNavItem } from "./components/layout/DashboardHeader";
import { pluginUserPagePath } from "./pages/user/pluginUserPageRoutes";

const AUTH_PRIMARY_NAV_PREFIXES = [
  "/admin",
  "/automations",
  "/memories",
  "/settings",
  "/plugins/",
  "/review",
] as const;

/** True when the path is only available to a signed-in viewer. */
export function isAuthPrimaryNavPath(pathname: string): boolean {
  return AUTH_PRIMARY_NAV_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix),
  );
}

/**
 * Low-traffic pages for every viewer. The desktop sidebar footer holds them.
 * On mobile they sit in the account links, or in the primary nav without an
 * account.
 */
export const SYSTEM_NAV_ITEMS: DashboardHeaderNavItem[] = [
  { key: "code", label: "Code", to: "/code" },
  { key: "system", label: "System", to: "/system" },
];

/** Build the signed-in primary nav, holding auth slots while shell data loads. */
export function buildPrimaryNavItems(input: {
  loading: boolean;
  loggedIn: boolean;
  pathname: string;
  primaryUserPages: PluginUserPageLink[];
  /** Open Review items assigned to the viewer. */
  reviewCount?: number;
}): DashboardHeaderNavItem[] {
  // Auth-only routes already imply the signed-in primary nav. Hold the Inbox
  // and Automations slots while core data catches up so the header does not jump.
  const reserveAuthPrimaryNav =
    input.loading && isAuthPrimaryNavPath(input.pathname);
  const showTasksNav = input.loggedIn || reserveAuthPrimaryNav;

  return [
    ...(showTasksNav
      ? [
          {
            count: input.reviewCount,
            key: "review",
            label: "Inbox",
            to: "/review",
          },
          { key: "automations", label: "Automations", to: "/automations" },
        ]
      : []),
    ...input.primaryUserPages.map(userPageNavItem),
  ];
}

/** Build the plugin pages in the profile menu. */
export function buildProfileNavItems(
  profileUserPages: PluginUserPageLink[],
): DashboardHeaderNavItem[] {
  return profileUserPages.map(userPageNavItem);
}

function userPageNavItem(page: PluginUserPageLink): DashboardHeaderNavItem {
  return {
    key: `${page.pluginName}:${page.id}`,
    label: page.label,
    to: pluginUserPagePath(page.pluginName, page.id),
  };
}
