import type { ReactNode } from "react";

import {
  PageContentSkeleton,
  type PageContentSkeletonVariant,
} from "../../components/PageContentSkeleton";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { SecondaryNavigation } from "../../components/layout/SecondaryNavigation";

const RESERVED_TASK_SEGMENTS = new Set(["list", "runs"]);

function isTasksListPath(pathname: string): boolean {
  if (pathname === "/automations/list") return true;
  const match = pathname.match(/^\/automations\/([^/]+)$/);
  return Boolean(match?.[1] && !RESERVED_TASK_SEGMENTS.has(match[1]));
}

const taskNavigationItems = [
  { end: true, label: "Overview", to: "/automations" },
  { isActive: isTasksListPath, label: "Automations", to: "/automations/list" },
  { label: "Runs", to: "/automations/runs" },
];

/** Place the shared secondary navigation above one Automations page. */
export function AutomationsPageLayout(props: { children: ReactNode }) {
  return (
    <>
      <SecondaryNavigation
        ariaLabel="Automations navigation"
        items={taskNavigationItems}
      />
      <PageLayout>{props.children}</PageLayout>
    </>
  );
}

/** Keep Automations chrome stable while shell or page data is still loading. */
export function AutomationsRouteLoading(props: {
  description: string;
  label: string;
  title: string;
  variant: Extract<PageContentSkeletonVariant, "list" | "stats">;
}) {
  return (
    <>
      <PageHeader description={props.description} title={props.title} />
      <PageContentSkeleton label={props.label} variant={props.variant} />
    </>
  );
}
