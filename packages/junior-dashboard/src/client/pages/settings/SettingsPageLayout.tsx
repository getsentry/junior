import type { ReactNode } from "react";

import { SecondaryNavigation } from "../../components/layout/SecondaryNavigation";

const settingsNavigationItems = [
  { end: true, label: "General", to: "/settings" },
  { label: "API tokens", to: "/settings/api-tokens" },
  { label: "Connected accounts", to: "/settings/connections" },
  { label: "MCP", to: "/settings/mcp" },
];

/** Place the shared secondary navigation above one Settings page. */
export function SettingsPageLayout(props: { children: ReactNode }) {
  return (
    <SecondaryNavigation
      ariaLabel="Settings navigation"
      items={settingsNavigationItems}
    >
      {props.children}
    </SecondaryNavigation>
  );
}
