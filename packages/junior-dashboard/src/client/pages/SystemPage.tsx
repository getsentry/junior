import type {
  ConversationStatsReport,
  PluginOperationalReport,
  PluginReport,
  SkillReport,
} from "@sentry/junior/api/schema";

import { PluginReports } from "../components/PluginReports";
import { EmptyTelemetry } from "../components/EmptyTelemetry";
import { Section } from "../components/Section";
import { SectionHeader } from "../components/SectionHeader";
import { SectionTitle } from "../components/SectionTitle";
import {
  formatCompactNumber,
  formatCostSummary,
  formatMs,
  formatTime,
} from "../format";
import { dashboardContainerClass } from "../styles";
import type { SystemData } from "../types";

type PluginRow = {
  name: string;
  skills: SkillReport[];
};

/** Render aggregate system activity with plugin inventory and reports. */
export function SystemPage(props: { data: SystemData }) {
  const stats = props.data.conversationStats;
  const plugins = props.data.plugins;
  const reports = props.data.pluginReports?.reports ?? [];
  const skills = props.data.skills;
  const reportsPending =
    props.data.pluginReportsLoading && reports.length === 0;
  const rows = buildPluginRows({ plugins, reports, skills });
  const reportEmptyText = props.data.pluginReportsError
    ? undefined
    : props.data.pluginReportsLoading
      ? "Loading plugin stats."
      : "No plugins have been reported yet.";

  return (
    <div className={`${dashboardContainerClass} px-4 py-4 md:px-8`}>
      <SystemActivity
        error={props.data.conversationStatsError}
        loading={props.data.conversationStatsLoading}
        stats={stats}
      />

      <Section>
        <SectionHeader>
          <div>
            <SectionTitle>Plugins</SectionTitle>
            <div className="mt-1 text-[0.82rem] leading-relaxed text-[#b8b8b8]">
              Loaded capabilities and operational reporting
            </div>
          </div>
        </SectionHeader>

        <div className="grid border-t border-white/10 sm:grid-cols-3">
          <SystemMetric label="loaded" value={plugins.length} />
          <SystemMetric
            label="reports"
            value={reportsPending ? "…" : reports.length}
          />
          <SystemMetric label="skills" value={skills.length} />
        </div>

        <div className="border-t border-white/10">
          <table className="w-full table-fixed border-collapse text-left text-[0.82rem] leading-tight">
            <colgroup>
              <col className="w-[42%]" />
              <col />
            </colgroup>
            <thead className="text-[0.7rem] uppercase text-[#888]">
              <tr>
                <th
                  className="border-b border-white/10 px-4 py-2 font-semibold"
                  scope="col"
                >
                  Plugin
                </th>
                <th
                  className="border-b border-white/10 px-4 py-2 font-semibold"
                  scope="col"
                >
                  Skills
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-4 text-[#888]" colSpan={2}>
                    No plugin inventory has been reported yet.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.name}>
                    <td className="break-words border-b border-white/10 px-4 py-2.5 align-top font-semibold text-white [overflow-wrap:anywhere]">
                      {row.name}
                    </td>
                    <td className="break-words border-b border-white/10 px-4 py-2.5 align-top text-[#d6d6d6] [overflow-wrap:anywhere]">
                      {row.skills.length
                        ? row.skills.map((skill) => skill.name).join(", ")
                        : "none"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Section>

      {props.data.pluginReportsError ? (
        <Section>
          <SectionHeader>
            <SectionTitle>Plugin Reports</SectionTitle>
          </SectionHeader>
          <div className="px-4 pb-4 text-[0.84rem] leading-relaxed text-[#fca5a5]">
            Plugin stats failed to load.
          </div>
        </Section>
      ) : null}

      <PluginReports emptyText={reportEmptyText} reports={reports} />
    </div>
  );
}

function SystemActivity(props: {
  error: boolean;
  loading: boolean;
  stats: ConversationStatsReport | undefined;
}) {
  const stats = props.stats;
  if (!stats) {
    return (
      <Section>
        <SectionHeader>
          <SectionTitle>System</SectionTitle>
        </SectionHeader>
        <div className="p-3">
          <EmptyTelemetry>
            {props.error
              ? "Conversation metrics failed to load."
              : props.loading
                ? "Loading conversation metrics."
                : "No conversation metrics have been reported yet."}
          </EmptyTelemetry>
        </div>
      </Section>
    );
  }
  const period = `${formatTime(stats.windowStart)} – ${formatTime(stats.windowEnd)}`;
  const metrics = [
    {
      label: "conversations",
      value: formatCompactNumber(stats.conversations),
    },
    { label: "active", value: formatCompactNumber(stats.active) },
    { label: "failed", value: formatCompactNumber(stats.failed) },
    { label: "runtime", value: formatMs(stats.durationMs) },
    {
      label: "tokens",
      value:
        stats.tokens === undefined ? "—" : formatCompactNumber(stats.tokens),
    },
    {
      label: "estimated cost",
      value:
        stats.costUsd === undefined
          ? "—"
          : formatCostSummary({ total: stats.costUsd }),
    },
  ];

  return (
    <Section>
      <SectionHeader>
        <div>
          <SectionTitle>System</SectionTitle>
          <div className="mt-1 break-words text-[0.82rem] leading-relaxed text-[#b8b8b8]">
            Seven-day conversation activity / {period}
          </div>
        </div>
      </SectionHeader>
      {props.error ? (
        <div className="border-b border-white/10 px-4 py-3 text-[0.84rem] leading-relaxed text-[#fca5a5]">
          Conversation metrics refresh failed. Showing cached data.
        </div>
      ) : null}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {metrics.map((metric) => (
          <SystemMetric key={metric.label} {...metric} />
        ))}
      </div>
    </Section>
  );
}

function SystemMetric(props: { label: string; value: number | string }) {
  const value =
    typeof props.value === "number"
      ? props.value.toLocaleString()
      : props.value;
  return (
    <div className="min-w-0 border-b border-r border-white/10 bg-[#050505] px-4 py-3 last:border-r-0">
      <div className="truncate text-2xl font-extrabold leading-none text-white">
        {value}
      </div>
      <div className="mt-1 text-[0.7rem] font-semibold uppercase leading-tight text-[#888]">
        {props.label}
      </div>
    </div>
  );
}

function buildPluginRows(input: {
  plugins: PluginReport[];
  reports: PluginOperationalReport[];
  skills: SkillReport[];
}): PluginRow[] {
  const names = new Set<string>();
  for (const plugin of input.plugins) names.add(plugin.name);
  for (const report of input.reports) names.add(report.pluginName);
  for (const skill of input.skills) {
    if (skill.pluginProvider) names.add(skill.pluginProvider);
  }

  return Array.from(names)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      skills: input.skills.filter((skill) => skill.pluginProvider === name),
    }));
}
