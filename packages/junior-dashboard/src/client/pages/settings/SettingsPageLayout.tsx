import type { ReactNode } from "react";

import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { SecondaryNavigation } from "../../components/layout/SecondaryNavigation";

const settingsNavigationItems = [
  { end: true, label: "General", to: "/settings" },
  { label: "API Tokens", to: "/settings/api-tokens" },
  { label: "Identities", to: "/settings/connections" },
  { label: "MCP", to: "/settings/mcp" },
];

/**
 * Place the Settings navigation and page header above one Settings page.
 * Forms keep a readable width under the header.
 */
export function SettingsPageLayout(props: {
  children: ReactNode;
  description: ReactNode;
  title: string;
}) {
  return (
    <SecondaryNavigation
      ariaLabel="Settings navigation"
      items={settingsNavigationItems}
    >
      <PageLayout>
        <PageHeader description={props.description} title={props.title} />
        <div className="grid w-full max-w-3xl min-w-0 gap-6">
          {props.children}
        </div>
      </PageLayout>
    </SecondaryNavigation>
  );
}
