import type { ReactNode } from "react";

import { getDashboardAgentName } from "../../agentName";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { SectionIntro } from "../../components/layout/SectionIntro";
import {
  PageContentSkeleton,
  type PageContentSkeletonVariant,
} from "../../components/PageContentSkeleton";
import { SegmentedNav } from "../../components/SegmentedNav";

export type SettingsSectionId = "general" | "api-tokens" | "identities" | "mcp";

type SettingsSection = {
  description(agentName: string): ReactNode;
  end?: boolean;
  label: string;
  loading: { label: string; variant?: PageContentSkeletonVariant };
  to: string;
};

// The loading and loaded states read the same title and description, so the
// section intro keeps its height when the page finishes loading.
const settingsSections: Record<SettingsSectionId, SettingsSection> = {
  general: {
    description: () => "Manage your profile and preferences.",
    end: true,
    label: "General",
    loading: { label: "Loading settings" },
    to: "/settings",
  },
  "api-tokens": {
    description: (agentName) => (
      <>
        Use a token to read {agentName} APIs from a local agent or script.
        Tokens expire after 90 days.
      </>
    ),
    label: "API Tokens",
    loading: { label: "Loading API tokens", variant: "list" },
    to: "/settings/api-tokens",
  },
  identities: {
    description: (agentName) => (
      <>
        Connect an account so {agentName} can act as you in conversations you
        start here.
      </>
    ),
    label: "Identities",
    loading: { label: "Loading identities", variant: "list" },
    to: "/settings/connections",
  },
  mcp: {
    description: (agentName) => (
      <>
        Connect Claude Code or another MCP client to list your {agentName}{" "}
        conversations. The client signs in through this dashboard. Personal API
        tokens do not work here.
      </>
    ),
    label: "MCP",
    loading: { label: "Loading MCP" },
    to: "/settings/mcp",
  },
};

const settingsNavigationItems = Object.values(settingsSections).map(
  ({ end, label, to }) => ({ end, label, to }),
);

/**
 * Place one Settings section under the Settings heading and its page links.
 * Settings opens from the profile menu, not the app navigation, so its page
 * links sit in the page instead of the header chrome.
 */
export function SettingsPageLayout(props: {
  children: ReactNode;
  section: SettingsSectionId;
}) {
  const section = settingsSections[props.section];
  return (
    <PageLayout>
      <div className="grid w-full max-w-3xl min-w-0 gap-8">
        <PageHeader
          documentTitle={section.label}
          navigation={
            <SegmentedNav
              ariaLabel="Settings navigation"
              items={settingsNavigationItems}
            />
          }
          title="Settings"
        />
        <section className="grid min-w-0 gap-5">
          <SectionIntro
            description={section.description(getDashboardAgentName())}
            title={section.label}
          />
          {props.children}
        </section>
      </div>
    </PageLayout>
  );
}

/** Keep the Settings chrome and section intro in place while a section loads. */
export function SettingsRouteLoading(props: { section: SettingsSectionId }) {
  const { loading } = settingsSections[props.section];
  return (
    <SettingsPageLayout section={props.section}>
      <PageContentSkeleton label={loading.label} variant={loading.variant} />
    </SettingsPageLayout>
  );
}
