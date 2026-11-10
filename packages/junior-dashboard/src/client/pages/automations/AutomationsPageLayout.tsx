import type { ReactNode } from "react";
import { matchPath, useLocation } from "react-router";

import { PageContentSkeleton } from "../../components/PageContentSkeleton";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { SecondaryNavigation } from "../../components/layout/SecondaryNavigation";
import { NewButton } from "../../components/layout/PaneNav";
import {
  AutomationSidebarList,
  useNewAutomationAction,
} from "./AutomationSidebarList";

/** Identify Automation routes whose run list scrolls on its own beside run details. */
export function hasAutomationDetailsFrame(pathname: string): boolean {
  return (
    Boolean(matchPath("/automations/runs", pathname)) ||
    Boolean(matchPath("/automations/:automationId/runs", pathname))
  );
}

const taskNavigationItems = [
  { end: true, label: "Automations", to: "/automations" },
  { label: "Runs", to: "/automations/runs" },
];

/** Keep Automation navigation consistent across the list and runs. */
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
  const { pathname } = useLocation();
  const list = hasAutomationDetailsFrame(pathname);
  const newAutomation = useNewAutomationAction();
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
        <PageLayout>
          {/* Phones have no pane, so the Automations tab lists them here,
              with New above the list. */}
          {pathname === "/automations" ? (
            <section
              className="grid gap-2 md:hidden"
              aria-label="Your automations"
            >
              <div className="flex items-center justify-between gap-3">
                <h2 className="m-0 font-display text-lg font-medium">
                  Automations
                </h2>
                <NewButton action={newAutomation} />
              </div>
              <AutomationSidebarList className="-mx-3 h-auto border-r-0 bg-transparent" />
            </section>
          ) : null}
          {props.children}
        </PageLayout>
      )}
    </AutomationsNavigation>
  );
}

/** Keep Automations chrome stable while shell or page data is still loading. */
export function AutomationsRouteLoading(props: {
  description?: string;
  label: string;
  title: string;
}) {
  const list = hasAutomationDetailsFrame(useLocation().pathname);
  const content = (
    <>
      <PageHeader description={props.description} title={props.title} />
      <PageContentSkeleton label={props.label} variant="list" />
    </>
  );
  return list ? <PageLayout>{content}</PageLayout> : content;
}
