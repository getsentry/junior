import type { ReactNode } from "react";

import { agentNamePossessive } from "../../agentName";
import { PageRouteLoading } from "../../components/PageRouteLoading";
import type { PageContentSkeletonVariant } from "../../components/PageContentSkeleton";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { Skeleton } from "../../components/ui/skeleton";
import { SystemActivityLoading } from "./SystemActivityLoading";
import { SystemNavigation } from "./SystemNavigation";

/** The range that the System overview opens with. */
export const systemOverviewDefaultRange: TimeRangeDays = 30;

/** Describe the System overview under its title. */
export function systemOverviewDescription(): string {
  return `A live read on ${agentNamePossessive()} runtime and model usage.`;
}

/** Place the shared secondary navigation above one System page. */
export function SystemPageLayout(props: { children: ReactNode }) {
  return (
    <SystemNavigation>
      <PageLayout>{props.children}</PageLayout>
    </SystemNavigation>
  );
}

/** Keep System navigation and expected page content stable during loading. */
export function SystemRouteLoading(props: {
  description: string;
  label: string;
  title: string;
  variant?: PageContentSkeletonVariant;
}) {
  return (
    <SystemNavigation>
      <PageRouteLoading {...props} />
    </SystemNavigation>
  );
}

/**
 * Hold the System overview layout before its page chunk or the dashboard data
 * loads: the same header, range control size, and activity cards.
 */
export function SystemOverviewRouteLoading() {
  return (
    <SystemPageLayout>
      <PageHeader
        actions={<Skeleton className="h-7 w-45 max-md:w-full" />}
        description={systemOverviewDescription()}
        title="System"
      />
      <SystemActivityLoading range={systemOverviewDefaultRange} />
    </SystemPageLayout>
  );
}
