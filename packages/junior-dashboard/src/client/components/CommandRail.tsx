import {
  formatTime,
  isFailedConversationSummary,
  visualStatusForSummary,
} from "../format";
import type { DashboardData } from "../types";
import { Section } from "./Section";
import { SectionHeader } from "./SectionHeader";
import { SectionTitle } from "./SectionTitle";
import { StatusBadge } from "./StatusBadge";

/** Render the command-center summary rail from the dashboard health payload. */
export function CommandRail(props: {
  data?: DashboardData;
  error: Error | null;
}) {
  const summaries = props.data?.conversations.conversations ?? [];
  const activeSummaries = summaries.filter(
    (summary) => visualStatusForSummary(summary) === "active",
  );
  const hungSummaries = summaries.filter(
    (summary) => visualStatusForSummary(summary) === "hung",
  );
  const failedSummaries = summaries.filter(isFailedConversationSummary);

  return (
    <aside className="min-w-0">
      <Section>
        <SectionHeader
          actions={
            <StatusBadge
              label={
                props.error ? "degraded" : props.data ? "online" : "checking"
              }
              status={props.error ? "failed" : props.data ? "active" : "idle"}
            />
          }
        >
          <SectionTitle>Pulse</SectionTitle>
        </SectionHeader>
        <div className="px-4 py-4">
          <div className="text-5xl font-black leading-none text-white md:text-6xl">
            {props.error
              ? "ERR"
              : (props.data?.health.status.toUpperCase() ?? "...")}
          </div>
          <div className="mt-3 break-words text-[0.88rem] leading-relaxed text-[#b8b8b8]">
            {props.error
              ? props.error.message
              : props.data
                ? `${props.data.health.service} / ${formatTime(props.data.health.timestamp)}`
                : "Waiting for Junior telemetry."}
          </div>
        </div>
        <div className="flex flex-wrap border-t border-white/10">
          <Stat label="plugins" value={props.data?.plugins.length ?? 0} />
          <Stat label="skills" value={props.data?.skills.length ?? 0} />
          <Stat label="active" value={activeSummaries.length} />
          <Stat label="hung" value={hungSummaries.length} />
          <Stat label="failed" value={failedSummaries.length} />
        </div>
      </Section>
    </aside>
  );
}

function Stat(props: { label: string; value: number }) {
  return (
    <div className="min-w-0 flex-1 basis-1/2 border-r border-t border-white/10 bg-[#050505] px-3 py-3 first:border-t-0 sm:basis-1/3">
      <div className="text-2xl font-extrabold leading-none text-white">
        {props.value}
      </div>
      <div className="mt-1 text-[0.78rem] font-semibold uppercase leading-tight text-[#888]">
        {props.label}
      </div>
    </div>
  );
}
