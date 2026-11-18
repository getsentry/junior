import { lazy, Suspense } from "react";
import { useLocation } from "react-router";

import { useConversationStatsData } from "../../api";
import type { DashboardCoreData } from "../../types";
import { SystemRouteLoading } from "./SystemPageLayout";
import { normalizeSystemPath } from "./SystemPlugins";

const SystemPage = lazy(() =>
  import("./SystemPage").then((module) => ({
    default: module.SystemPage,
  })),
);

/** Render the System pages, starting the slow overview stats at once. */
export function SystemRoute(props: { coreData: DashboardCoreData }) {
  // The query starts while the page chunk loads. The Suspense boundary lets
  // this route commit, which starts it.
  useConversationStatsData({
    enabled: normalizeSystemPath(useLocation().pathname) === "/system",
  });
  return (
    <Suspense
      fallback={
        <SystemRouteLoading
          description="Runtime health, model usage, and loaded capabilities."
          label="Loading system"
          title="System"
          variant="overview"
        />
      }
    >
      <SystemPage coreData={props.coreData} />
    </Suspense>
  );
}
