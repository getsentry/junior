import { PluginReports } from "../components/PluginReports";
import { Section } from "../components/Section";
import { SectionHeader } from "../components/SectionHeader";
import { SectionTitle } from "../components/SectionTitle";
import type {
  DashboardData,
  Plugin,
  PluginDashboardReport,
  Skill,
} from "../types";

type PluginRow = {
  name: string;
  plugin?: Plugin;
  report?: PluginDashboardReport;
  skills: Skill[];
};

/** Render plugin inventory and trusted-plugin dashboard summaries. */
export function PluginsPage(props: { data?: DashboardData }) {
  const rows = buildPluginRows({
    plugins: props.data?.plugins ?? [],
    reports: props.data?.pluginReports.reports ?? [],
    skills: props.data?.skills ?? [],
  });
  const reportCount = props.data?.pluginReports.reports.length ?? 0;
  const loadedCount = props.data?.plugins.length ?? 0;
  const skillCount = props.data?.skills.length ?? 0;

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

        <PluginReports
          emptyText="No trusted plugin stats have been reported yet."
          reports={props.data?.pluginReports.reports ?? []}
        />
      </section>
    </div>
  );
}

function PluginMetric(props: { label: string; value: number }) {
  return (
    <div className="min-w-0 border-r border-white/10 bg-[#050505] px-4 py-3 last:border-r-0 max-sm:border-b">
      <div className="truncate text-3xl font-extrabold leading-none text-white">
        {props.value.toLocaleString()}
      </div>
      <div className="mt-1 text-[0.72rem] font-semibold uppercase leading-tight text-[#888]">
        {props.label}
      </div>
    </div>
  );
}

function buildPluginRows(input: {
  plugins: Plugin[];
  reports: PluginDashboardReport[];
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
