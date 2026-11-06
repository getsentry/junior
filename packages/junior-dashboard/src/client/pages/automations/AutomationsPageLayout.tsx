import type { ReactNode } from "react";
import { matchPath, useLocation } from "react-router";

import {
  PageContentSkeleton,
  type PageContentSkeletonVariant,
} from "../../components/PageContentSkeleton";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { SecondaryNavigation } from "../../components/layout/SecondaryNavigation";

/** Identify Automation routes whose run list scrolls on its own beside run details. */
export function hasAutomationDetailsFrame(pathname: string): boolean {
  return (
    Boolean(matchPath("/automations/runs", pathname)) ||
    Boolean(matchPath("/automations/:automationId/runs", pathname))
  );
}

const taskNavigationItems = [
  { end: true, label: "Overview", to: "/automations" },
  { label: "Automations", to: "/automations/list" },
  { label: "Runs", to: "/automations/runs" },
];

/** Keep Automation navigation consistent across the overview, list, and runs. */
function AutomationsNavigation(props: {
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
  const list = hasAutomationDetailsFrame(useLocation().pathname);
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
  const list = hasAutomationDetailsFrame(useLocation().pathname);
  const content = (
    <>
      <PageHeader description={props.description} title={props.title} />
      <PageContentSkeleton label={props.label} variant={props.variant} />
    </>
  );
  return list ? <PageLayout>{content}</PageLayout> : content;
}
