import type { ReactNode } from "react";

import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { SectionIntro } from "../../components/layout/SectionIntro";
import { SegmentedNav } from "../../components/SegmentedNav";

const settingsNavigationItems = [
  { end: true, label: "General", to: "/settings" },
  { label: "API Tokens", to: "/settings/api-tokens" },
  { label: "Identities", to: "/settings/connections" },
  { label: "MCP", to: "/settings/mcp" },
];

/**
 * Place one Settings section under the Settings heading and its page links.
 * Settings opens from the profile menu, not the app navigation, so its page
 * links sit in the page instead of the header chrome.
 */
export function SettingsPageLayout(props: {
  children: ReactNode;
  description: ReactNode;
  title: string;
}) {
  return (
    <PageLayout>
      <div className="grid w-full max-w-3xl min-w-0 gap-8">
        <PageHeader
          documentTitle={props.title}
          navigation={
            <SegmentedNav
              ariaLabel="Settings navigation"
              items={settingsNavigationItems}
            />
          }
          title="Settings"
        />
        <section className="grid min-w-0 gap-5">
          <SectionIntro description={props.description} title={props.title} />
          {props.children}
        </section>
      </div>
    </PageLayout>
  );
}
