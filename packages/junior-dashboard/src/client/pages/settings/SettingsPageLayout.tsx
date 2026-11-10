import type { ReactNode } from "react";

import { anchorTitleId } from "../../components/layout/AnchorHeading";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { SectionIntro } from "../../components/layout/SectionIntro";

/** The Settings sections in page order, for the pane list. */
export const settingsSections = [
  { anchor: "general", label: "General" },
  { anchor: "api-tokens", label: "API Tokens" },
  { anchor: "identities", label: "Identities" },
  { anchor: "mcp", label: "MCP" },
];

/**
 * Put the Settings sections on one scrolling page under the Settings
 * heading, like Android settings. The pane lists the sections.
 */
export function SettingsPageLayout(props: { children: ReactNode }) {
  return (
    <PageLayout>
      <div className="grid w-full max-w-3xl min-w-0 gap-12">
        <PageHeader title="Settings" />
        {props.children}
      </div>
    </PageLayout>
  );
}

/** One Settings section. Links reach it with `#anchor`. */
export function SettingsSection(props: {
  anchor: string;
  children: ReactNode;
  description: ReactNode;
  title: string;
}) {
  return (
    <section
      aria-labelledby={anchorTitleId(props.anchor)}
      className="grid min-w-0 gap-5"
    >
      <SectionIntro
        anchor={props.anchor}
        description={props.description}
        title={props.title}
      />
      {props.children}
    </section>
  );
}
