import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  pluginOperationalReportFeedSchema,
  pluginsSchema,
  runtimeInfoReportSchema,
  skillDetailReportSchema,
  skillReportsSchema,
} from "./reporting-schema";
import type {
  PluginOperationalReportFeed,
  Plugin,
  RuntimeInfoReport,
  SkillDetailReport,
  SkillReport,
} from "./reporting-schema";

export {
  healthReportSchema,
  pluginOperationalReportFeedSchema,
  pluginOperationalReportSchema,
  pluginPackageContentItemReportSchema,
  pluginPackageContentReportSchema,
  pluginSchema,
  pluginsSchema,
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
  Plugin,
  Plugins,
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

/** Read discovered skills for runtime diagnostics and the Automation editor. */
export async function readSkillReports(): Promise<SkillReport[]> {
  const { discoverSkills } = await import("@/chat/skills");
  const skills = await discoverSkills();
  return skillReportsSchema.parse(
    skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      pluginProvider: skill.pluginProvider,
      disableModelInvocation: skill.disableModelInvocation,
    })),
  );
}

/**
 * Read one discovered skill with the body its author wrote, so people can see
 * what the skill tells Junior. Returns null when no skill has that name.
 */
export async function readSkillDetailReport(
  name: string,
): Promise<SkillDetailReport | null> {
  const { discoverSkills, findSkillByName, parseSkillFile } =
    await import("@/chat/skills");
  const skill = findSkillByName(name, await discoverSkills());
  if (!skill) return null;
  const raw = await fs.readFile(path.join(skill.skillPath, "SKILL.md"), "utf8");
  const parsed = parseSkillFile(raw, skill.name);
  if (!parsed.ok) {
    throw new Error(`Invalid skill file for ${skill.name}: ${parsed.error}`);
  }
  return skillDetailReportSchema.parse({
    name: skill.name,
    description: skill.description,
    pluginProvider: skill.pluginProvider,
    disableModelInvocation: skill.disableModelInvocation,
    body: parsed.skill.body,
  });
}

/** Read safe configured plugin metadata for authenticated runtime diagnostics. */
export async function readPlugins(): Promise<Plugin[]> {
  const { pluginCatalogRuntime } =
    await import("@/chat/plugins/catalog-runtime");
  return pluginsSchema.parse(
    pluginCatalogRuntime.getProviders().map((plugin) => ({
      configKeys: plugin.manifest.configKeys ?? [],
      description: plugin.manifest.description,
      displayName: plugin.manifest.displayName,
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
      readPlugins(),
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

/** Read the Brief report and sanitized operational summaries from plugins. */
export async function readPluginOperationalReportFeed(): Promise<PluginOperationalReportFeed> {
  const nowMs = Date.now();
  const [
    { isBriefsEnabled },
    { BRIEF_EVENT_NAMESPACE },
    { buildBriefsOperationalReport },
    { logException },
    { failedOperationalReport, getPluginOperationalReports },
  ] = await Promise.all([
    import("@/chat/briefs/config"),
    import("@/chat/briefs/events"),
    import("@/chat/briefs/operational-report"),
    import("@/chat/logging"),
    import("@/chat/plugins/agent-hooks"),
  ]);
  const readBriefsReport = async () => {
    try {
      return await buildBriefsOperationalReport(nowMs);
    } catch (error) {
      // The System page shows a failed card and keeps the other reports.
      logException(error, "briefs.operational_report.failed");
      return failedOperationalReport({
        nowMs,
        pluginName: BRIEF_EVENT_NAMESPACE,
      });
    }
  };
  return pluginOperationalReportFeedSchema.parse({
    source: "plugins",
    generatedAt: new Date(nowMs).toISOString(),
    reports: [
      ...(isBriefsEnabled() ? [await readBriefsReport()] : []),
      ...(await getPluginOperationalReports(nowMs)),
    ],
  });
}
