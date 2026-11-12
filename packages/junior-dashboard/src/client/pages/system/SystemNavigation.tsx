import type { ReactNode } from "react";
import { matchPath } from "react-router";

import { SecondaryNavigation } from "../../components/layout/SecondaryNavigation";
import { systemPluginsPath } from "./SystemPlugins";

const systemNavigationItems = [
  { end: true, label: "Overview", to: "/system" },
  { label: "People", to: "/system/people" },
  { label: "Locations", to: "/system/locations" },
  { label: "Workspaces", to: "/system/workspaces" },
  { label: "Plugins", to: systemPluginsPath },
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
    >
      {props.children}
    </SecondaryNavigation>
  );
}
