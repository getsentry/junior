import type { ReactNode } from "react";
import { matchPath } from "react-router";

import { SecondaryNavigation } from "../../components/layout/SecondaryNavigation";
import { NAV_PAGES, navAreaPages } from "../../navPages";

/** The System pages, for the in-page links and the pane list. */
export const systemNavigationItems = [
  { end: true, label: "Overview", to: NAV_PAGES.system.to },
  ...navAreaPages(NAV_PAGES.system.to),
];

/** Identify Workspace routes whose list scrolls on its own beside the details. */
export function hasWorkspaceDetailsFrame(pathname: string): boolean {
  if (matchPath("/system/workspaces", pathname)) return true;
  const match = matchPath("/system/workspaces/:workspaceId", pathname);
  return Boolean(match && match.params.workspaceId !== "new");
}

/** Render the stable secondary navigation shared by System pages. */
export function SystemNavigation(props: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <SecondaryNavigation
      ariaLabel="System navigation"
      className={props.className}
      items={systemNavigationItems}
      listedInPane
    >
      {props.children}
    </SecondaryNavigation>
  );
}
