import { readFileSync } from "node:fs";
import path from "node:path";
import {
  pluginOperationalReportFeedSchema,
  pluginReportsSchema,
  runtimeInfoReportSchema,
  skillReportsSchema,
} from "./reporting-schema";
import type {
  PluginOperationalReportFeed,
  PluginReport,
  RuntimeInfoReport,
  SkillReport,
} from "./reporting-schema";

export {
  healthReportSchema,
  pluginOperationalReportFeedSchema,
  pluginOperationalReportSchema,
  pluginPackageContentItemReportSchema,
  pluginPackageContentReportSchema,
  pluginReportSchema,
  pluginReportsSchema,
  runtimeInfoReportSchema,
  skillReportSchema,
  skillReportsSchema,
} from "./reporting-schema";
export { readHealthReport } from "./handlers/health";
export type {
  HealthReport,
  PluginOperationalReport,
  PluginOperationalReportFeed,
  PluginPackageContentItemReport,
  PluginPackageContentReport,
  PluginReport,
  PluginReports,
  RuntimeInfoReport,
  SkillReport,
  SkillReports,
} from "./reporting-schema";

function readDescriptionText(home: string): string | undefined {
  try {
    const raw = readFileSync(path.join(home, "DESCRIPTION.md"), "utf8").trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

/** Read discovered skill names for authenticated runtime diagnostics. */
export async function readSkillReports(): Promise<SkillReport[]> {
  const { discoverSkills } = await import("@/chat/skills");
  const skills = await discoverSkills();
  return skillReportsSchema.parse(
    skills.map((skill) => ({
      name: skill.name,
      pluginProvider: skill.pluginProvider,
    })),
  );
}

/** Read configured plugin names for authenticated runtime diagnostics. */
export async function readPluginReports(): Promise<PluginReport[]> {
  const { pluginCatalogRuntime } =
    await import("@/chat/plugins/catalog-runtime");
  return pluginReportsSchema.parse(
    pluginCatalogRuntime.getProviders().map((plugin) => ({
      name: plugin.manifest.name,
    })),
  );
}

/** Read authenticated runtime discovery data. */
export async function readRuntimeInfoReport(): Promise<RuntimeInfoReport> {
  const [{ homeDir }, { pluginCatalogRuntime }, plugins, skills] =
    await Promise.all([
      import("@/chat/discovery"),
      import("@/chat/plugins/catalog-runtime"),
      readPluginReports(),
      readSkillReports(),
    ]);
  const home = homeDir();

  return runtimeInfoReportSchema.parse({
    cwd: process.cwd(),
    homeDir: home,
    descriptionText: readDescriptionText(home),
    providers: plugins.map((plugin) => plugin.name),
    skills,
    packagedContent: pluginCatalogRuntime.getPackageContent(),
  });
}

/** Read sanitized operational summaries contributed by plugins. */
export async function readPluginOperationalReportFeed(): Promise<PluginOperationalReportFeed> {
  const nowMs = Date.now();
  const { getPluginOperationalReports } =
    await import("@/chat/plugins/agent-hooks");
  return pluginOperationalReportFeedSchema.parse({
    source: "plugins",
    generatedAt: new Date(nowMs).toISOString(),
    reports: await getPluginOperationalReports(nowMs),
  });
}
