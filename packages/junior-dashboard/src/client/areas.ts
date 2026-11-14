import { useCodeOverviewData } from "./api";
import type { Area } from "./components/layout/AreaSidebar";
import type { DashboardHeaderNavItem } from "./components/layout/DashboardHeader";
import { codeRepositoryPath } from "./pages/code/codeRepositoryRoutes";
import {
  memoryNavigationItems,
  memoryOverviewSections,
} from "./pages/memory/MemoryPageLayout";
import { settingsSections } from "./pages/settings/SettingsPageLayout";
import { systemNavigationItems } from "./pages/system/SystemNavigation";

function under(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

function sectionItems(
  page: string,
  sections: readonly { anchor: string; label: string }[],
) {
  return sections.map((section) => ({
    anchor: section.anchor,
    label: section.label,
    to: `${page}#${section.anchor}`,
  }));
}

/**
 * Name the area outside the tabs that a path is in, with the pages its pane
 * lists: Settings lists the sections of its one page; System, Memories,
 * and Code list their pages, and the Memories Overview its sections; plugin
 * pages list each other. Any other page lists every area, so the pane is
 * never empty. Tab paths have no area.
 */
export function useArea(
  pathname: string,
  navItems: {
    primary: readonly DashboardHeaderNavItem[];
    profile: readonly DashboardHeaderNavItem[];
  },
  isTabPath: boolean,
): Area | undefined {
  const code = under(pathname, "/code");
  const repositories = useCodeOverviewData(code).data?.repositories ?? [];
  if (isTabPath) return undefined;
  if (under(pathname, "/settings"))
    return {
      items: sectionItems("/settings", settingsSections),
      label: "Settings",
      root: "/settings",
    };
  if (under(pathname, "/system"))
    return { items: systemNavigationItems, label: "System", root: "/system" };
  if (under(pathname, "/memories"))
    return {
      items: [
        memoryNavigationItems[0]!,
        ...sectionItems("/memories", memoryOverviewSections),
        ...memoryNavigationItems.slice(1),
      ],
      label: "Memories",
      root: "/memories",
    };
  if (code)
    return {
      items: [
        { end: true, label: "Overview", to: "/code" },
        ...repositories.map((repository) => ({
          detail: repository.provider,
          label: repository.name,
          to: codeRepositoryPath(repository.id),
        })),
      ],
      label: "Code",
      root: "/code",
    };
  const more = [
    ...navItems.profile.map((item) => ({ label: item.label, to: item.to })),
    { label: "Settings", to: "/settings" },
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
