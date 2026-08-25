import type { ReactNode } from "react";

import {
  PageContentSkeleton,
  type PageContentSkeletonVariant,
} from "../../components/PageContentSkeleton";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { SecondaryNavigation } from "../../components/layout/SecondaryNavigation";

const taskNavigationItems = [
  { end: true, label: "Overview", to: "/tasks" },
  { label: "Tasks", to: "/tasks/list" },
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
