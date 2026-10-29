import type { ReactNode } from "react";
import { useLocation } from "react-router";

import {
  PageContentSkeleton,
  type PageContentSkeletonVariant,
} from "../../components/PageContentSkeleton";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { SecondaryNavigation } from "../../components/layout/SecondaryNavigation";

const RESERVED_AUTOMATION_SEGMENTS = new Set(["list", "runs"]);

/** Identify list and detail routes that share the Automation list scroll frame. */
export function isAutomationListPath(pathname: string): boolean {
  if (pathname === "/automations/list") return true;
  const match = pathname.match(/^\/automations\/([^/]+)$/);
  return Boolean(match?.[1] && !RESERVED_AUTOMATION_SEGMENTS.has(match[1]));
}

function isAutomationListTabPath(pathname: string): boolean {
  return (
    isAutomationListPath(pathname) ||
    /^\/automations\/[^/]+\/edit$/.test(pathname)
  );
}

const taskNavigationItems = [
  { end: true, label: "Overview", to: "/automations" },
  {
    isActive: isAutomationListTabPath,
    label: "Automations",
    to: "/automations/list",
  },
  { label: "Runs", to: "/automations/runs" },
];

/** Keep Automation navigation consistent across lists, details, and editing. */
export function AutomationsNavigation(props: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <SecondaryNavigation
      ariaLabel="Automations navigation"
      className={props.className}
      items={taskNavigationItems}
    >
      {props.children}
    </SecondaryNavigation>
  );
}

/** Place the shared secondary navigation above one Automations page. */
export function AutomationsPageLayout(props: { children: ReactNode }) {
  const list = isAutomationListPath(useLocation().pathname);
  return (
    <AutomationsNavigation
      className={
        list
          ? "grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]"
          : undefined
      }
    >
      {list ? (
        <div className="min-h-0">{props.children}</div>
      ) : (
        <PageLayout>{props.children}</PageLayout>
      )}
    </AutomationsNavigation>
  );
}

/** Keep Automations chrome stable while shell or page data is still loading. */
export function AutomationsRouteLoading(props: {
  description: string;
  label: string;
  title: string;
  variant: Extract<PageContentSkeletonVariant, "list" | "stats">;
}) {
  const list = isAutomationListPath(useLocation().pathname);
  const content = (
    <>
      <PageHeader description={props.description} title={props.title} />
      <PageContentSkeleton label={props.label} variant={props.variant} />
    </>
  );
  return list ? <PageLayout>{content}</PageLayout> : content;
}
