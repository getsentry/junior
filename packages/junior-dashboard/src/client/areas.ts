import type { Area } from "./components/layout/AreaSidebar";
import type { DashboardHeaderNavItem } from "./shell/components/layout/DashboardHeader";
import { memoryNavigationItems } from "./shell/pages/memory/MemoryPageLayout";
import { NAV_PAGES, navAreaPages } from "./navPages";
import { systemNavigationItems } from "./pages/system/SystemNavigation";

function under(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

/** The sections of an area's root page. */
function sectionItems(root: string) {
  return navAreaPages(root).filter((page) => page.anchor);
}

/**
 * Name the area outside the tabs that a path is in, with the pages its pane
 * lists: Settings lists the sections of its one page; System and Memories
 * list their pages, and the Memories Overview its sections; plugin
 * pages list each other. Any other page lists every area, so the pane is
 * never empty. Tab paths have no area.
 */
export function areaForPath(
  pathname: string,
  navItems: {
    primary: readonly DashboardHeaderNavItem[];
    profile: readonly DashboardHeaderNavItem[];
  },
  isTabPath: boolean,
): Area | undefined {
  if (isTabPath) return undefined;
  if (under(pathname, NAV_PAGES.settings.to))
    return {
      items: sectionItems(NAV_PAGES.settings.to),
      label: NAV_PAGES.settings.label,
      root: NAV_PAGES.settings.to,
    };
  if (under(pathname, "/system"))
    return { items: systemNavigationItems, label: "System", root: "/system" };
  if (under(pathname, "/memories"))
    return {
      items: [
        memoryNavigationItems[0]!,
        ...sectionItems(NAV_PAGES.memoryLibrary.area),
        ...memoryNavigationItems.slice(1),
      ],
      label: "Memories",
      root: "/memories",
    };
  const more = [
    ...navItems.profile.map((item) => ({ label: item.label, to: item.to })),
    NAV_PAGES.settings,
  ];
  if (under(pathname, "/plugins"))
    return {
      // Primary plugin pages have a nav tab too, but they list here with
      // the profile ones, so the page on screen is always in the list.
      items: [...navItems.primary, ...navItems.profile]
        .filter((item) => item.to.startsWith("/plugins/"))
        .map((item) => ({ label: item.label, to: item.to })),
      label: "Pages",
      // No page lists the plugin pages, so phones open each one directly.
      root: "",
    };
  return { items: more, label: "More", root: "" };
}
