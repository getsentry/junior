import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";

import { anchorTitleId } from "../../components/layout/AnchorHeading";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { SectionIntro } from "../../components/layout/SectionIntro";

/** The Settings sections in page order. */
const settingsSections = [
  { anchor: "general", label: "General" },
  { anchor: "interface", label: "Interface" },
  { anchor: "api-tokens", label: "API Tokens" },
  { anchor: "identities", label: "Identities" },
  { anchor: "mcp", label: "MCP" },
];

/**
 * Put the Settings sections on one scrolling page under the Settings
 * heading. Links under the heading jump to each section.
 */
export function SettingsPageLayout(props: { children: ReactNode }) {
  const { search } = useLocation();
  return (
    <PageLayout>
      <div className="grid w-full max-w-3xl min-w-0 gap-12">
        <PageHeader
          navigation={
            <nav
              aria-label="Settings sections"
              className="flex flex-wrap gap-x-5 gap-y-2 pb-4 sm:pb-6"
            >
              {settingsSections.map((section) => (
                <Link
                  className="font-sans text-sm font-medium text-dashboard-text-muted no-underline transition-colors hover:text-dashboard-text"
                  key={section.anchor}
                  to={{ hash: section.anchor, search }}
                >
                  {section.label}
                </Link>
              ))}
            </nav>
          }
          title="Settings"
        />
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
