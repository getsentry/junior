import type { ReactNode } from "react";

import { PageLayout } from "../../components/layout/PageLayout";
import { SecondaryNavigation } from "../../components/layout/SecondaryNavigation";

const TASK_NAVIGATION_ITEMS = [
  { end: true, label: "Overview", to: "/tasks" },
  { label: "Tasks", to: "/tasks/list" },
  { label: "Runs", to: "/tasks/runs" },
];

/** Place the shared secondary navigation above one Tasks page. */
export function TasksPageLayout(props: { children: ReactNode }) {
  return (
    <div className="min-w-0">
      <SecondaryNavigation
        ariaLabel="Tasks navigation"
        items={TASK_NAVIGATION_ITEMS}
      />
      <PageLayout>{props.children}</PageLayout>
    </div>
  );
}
