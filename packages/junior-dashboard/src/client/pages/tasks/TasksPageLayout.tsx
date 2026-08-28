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
  if (pathname === "/tasks/list" || pathname.startsWith("/tasks/list/")) {
    return true;
  }
  const match = pathname.match(/^\/tasks\/([^/]+)$/);
  return Boolean(match?.[1] && !RESERVED_TASK_SEGMENTS.has(match[1]));
}

const taskNavigationItems = [
  { end: true, label: "Overview", to: "/tasks" },
  { isActive: isTasksListPath, label: "Tasks", to: "/tasks/list" },
  { label: "Runs", to: "/tasks/runs" },
];

/** Place the shared secondary navigation above one Tasks page. */
export function TasksPageLayout(props: { children: ReactNode }) {
  return (
    <>
      <SecondaryNavigation
        ariaLabel="Tasks navigation"
        items={taskNavigationItems}
      />
      <PageLayout>{props.children}</PageLayout>
    </>
  );
}

/** Keep Tasks chrome stable while shell or page data is still loading. */
export function TasksRouteLoading(props: {
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
