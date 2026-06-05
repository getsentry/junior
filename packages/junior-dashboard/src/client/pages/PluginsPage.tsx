import { PluginReports } from "../components/PluginReports";
import { Section } from "../components/Section";
import { SectionHeader } from "../components/SectionHeader";
import { SectionTitle } from "../components/SectionTitle";
import type { DashboardData, Plugin, PluginReport, Skill } from "../types";

type PluginRow = {
  name: string;
  plugin?: Plugin;
  report?: PluginReport;
  skills: Skill[];
};

/** Render plugin inventory and trusted-plugin operational summaries. */
export function PluginsPage(props: { data?: DashboardData }) {
  const plugins = props.data?.plugins ?? [];
  const reports = props.data?.pluginReports?.reports ?? [];
  const skills = props.data?.skills ?? [];
  const reportsError = props.data?.pluginReportsError ?? false;
  const reportsLoading = props.data?.pluginReportsLoading ?? false;
  const reportsPending = reportsLoading && reports.length === 0;
  const rows = buildPluginRows({
    plugins,
    reports,
    skills,
  });
  const reportCount = reportsPending ? "..." : reports.length;
  const loadedCount = plugins.length;
  const skillCount = skills.length;
  const reportEmptyText = reportsError
    ? undefined
    : reportsLoading
      ? "Loading trusted plugin stats."
      : "No plugins have been reported yet.";

  return (
    <div className="mx-auto w-full min-w-0 max-w-screen-xl px-4 py-4 md:px-8">
      <section className="min-w-0">
        <Section>
          <SectionHeader>
            <SectionTitle>Plugins</SectionTitle>
          </SectionHeader>

          <div className="grid border-t border-white/10 sm:grid-cols-3">
            <PluginMetric label="loaded" value={loadedCount} />
            <PluginMetric label="reports" value={reportCount} />
            <PluginMetric label="skills" value={skillCount} />
          </div>

          <div className="overflow-x-auto border-t border-white/10">
            <table className="w-full min-w-[42rem] border-collapse text-left text-[0.82rem] leading-tight">
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
                    Inventory
                  </th>
                  <th
                    className="border-b border-white/10 px-4 py-2 font-semibold"
                    scope="col"
                  >
                    Report
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
                    <td className="px-4 py-4 text-[#888]" colSpan={4}>
                      No plugin inventory has been reported yet.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr key={row.name}>
                      <td className="max-w-72 truncate border-b border-white/10 px-4 py-2.5 font-semibold text-white">
                        {row.name}
                      </td>
                      <td className="border-b border-white/10 px-4 py-2.5 text-[#d6d6d6]">
                        {row.plugin ? "loaded" : "report-only"}
                      </td>
                      <td className="border-b border-white/10 px-4 py-2.5 text-[#d6d6d6]">
                        {row.report
                          ? (row.report.title ?? "available")
                          : reportsPending
                            ? "loading"
                            : "none"}
                      </td>
                      <td className="max-w-96 truncate border-b border-white/10 px-4 py-2.5 text-[#d6d6d6]">
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

        {reportsError ? (
          <Section>
            <SectionHeader>
              <SectionTitle>Plugin Reports</SectionTitle>
            </SectionHeader>
            <div className="px-4 pb-4 text-[0.84rem] leading-relaxed text-[#fca5a5]">
              Trusted plugin stats failed to load.
            </div>
          </Section>
        ) : null}

        <PluginReports emptyText={reportEmptyText} reports={reports} />
      </section>
    </div>
  );
}

function PluginMetric(props: { label: string; value: number | string }) {
  const value =
    typeof props.value === "number"
      ? props.value.toLocaleString()
      : props.value;
  return (
    <div className="min-w-0 border-r border-white/10 bg-[#050505] px-4 py-3 last:border-r-0 max-sm:border-b">
      <div className="truncate text-3xl font-extrabold leading-none text-white">
        {value}
      </div>
      <div className="mt-1 text-[0.72rem] font-semibold uppercase leading-tight text-[#888]">
        {props.label}
      </div>
    </div>
  );
}

function buildPluginRows(input: {
  plugins: Plugin[];
  reports: PluginReport[];
  skills: Skill[];
}): PluginRow[] {
  const names = new Set<string>();
  for (const plugin of input.plugins) {
    names.add(plugin.name);
  }
  for (const report of input.reports) {
    names.add(report.pluginName);
  }
  for (const skill of input.skills) {
    if (skill.pluginProvider) {
      names.add(skill.pluginProvider);
    }
  }

  return Array.from(names)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      plugin: input.plugins.find((plugin) => plugin.name === name),
      report: input.reports.find((report) => report.pluginName === name),
      skills: input.skills.filter((skill) => skill.pluginProvider === name),
    }));
}
