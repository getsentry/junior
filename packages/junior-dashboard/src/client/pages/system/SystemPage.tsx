import { PageHeader } from "../../components/layout/PageHeader";
import { cn, dashboardContainerClass } from "../../styles";
import type { SystemData } from "../../types";
import { SystemActivity } from "./SystemActivity";
import { SystemCapabilities } from "./SystemCapabilities";

/** Render aggregate system activity with plugin inventory and reports. */
export function SystemPage(props: { data: SystemData }) {
  const reports = props.data.pluginReports?.reports ?? [];
  const reportsPending =
    props.data.pluginReportsLoading && reports.length === 0;

  return (
    <div
      className={cn(
        dashboardContainerClass,
        "grid min-w-0 gap-4 px-4 py-4 sm:gap-6 sm:px-8 sm:py-8",
      )}
    >
      <PageHeader
        description="A live read on Junior's runtime, model usage, loaded capabilities, and the systems keeping work moving."
        eyebrow="Junior's engine room"
        title="System"
      />

      <SystemActivity
        error={props.data.conversationStatsError}
        loading={props.data.conversationStatsLoading}
        stats={props.data.conversationStats}
      />

      <SystemCapabilities
        loadingReports={reportsPending}
        pluginReportsError={props.data.pluginReportsError}
        plugins={props.data.plugins}
        reports={reports}
        skills={props.data.skills}
      />
    </div>
  );
}
