import type { PluginUserPageLink } from "@sentry/junior-plugin-api";

import type { DashboardHeaderNavItem } from "./components/layout/DashboardHeader";
import { NAV_PAGES } from "../navPages";
import { pluginUserPagePath } from "../pages/user/pluginUserPageRoutes";

const AUTH_PRIMARY_NAV_PREFIXES = [
  "/admin",
  "/automations",
  "/memories",
  "/settings",
  "/plugins/",
] as const;

/** True when the path is only available to a signed-in viewer. */
export function isAuthPrimaryNavPath(pathname: string): boolean {
  return AUTH_PRIMARY_NAV_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix),
  );
}

function navItem(
  key: "automations" | "code" | "inbox" | "system",
): DashboardHeaderNavItem {
  return { key, label: NAV_PAGES[key].label, to: NAV_PAGES[key].to };
}

const SYSTEM_NAV_ITEM = navItem("system");

/** Build the signed-in primary nav, holding auth slots while shell data loads. */
export function buildPrimaryNavItems(input: {
  loading: boolean;
  loggedIn: boolean;
  pathname: string;
  primaryUserPages: PluginUserPageLink[];
  /** What waits on the viewer: To do in the Inbox. */
  inboxCount?: number | undefined;
}): DashboardHeaderNavItem[] {
  // Auth-only routes already imply the signed-in primary nav. Hold the
  // Automations slot while core data catches up so the header does not jump.
  const reserveAuthPrimaryNav =
    input.loading && isAuthPrimaryNavPath(input.pathname);
  const showTasksNav = input.loggedIn || reserveAuthPrimaryNav;
  // Signed-in viewers find System in the profile menu. Without an account
  // there is no profile menu, so the page stays here.
  const showAccountPages = !input.loading && !input.loggedIn;

  return [
    { ...navItem("inbox"), count: input.inboxCount },
    navItem("code"),
    ...(showTasksNav ? [navItem("automations")] : []),
    ...input.primaryUserPages.map(userPageNavItem),
    ...(showAccountPages ? [SYSTEM_NAV_ITEM] : []),
  ];
}

/** Build the pages in the profile menu: plugin profile pages, and System. */
export function buildProfileNavItems(
  profileUserPages: PluginUserPageLink[],
): DashboardHeaderNavItem[] {
  return [...profileUserPages.map(userPageNavItem), SYSTEM_NAV_ITEM];
}

function userPageNavItem(page: PluginUserPageLink): DashboardHeaderNavItem {
  return {
    key: `${page.pluginName}:${page.id}`,
    label: page.label,
    to: pluginUserPagePath(page.pluginName, page.id),
  };
}
