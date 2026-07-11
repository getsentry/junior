import { readFileSync } from "node:fs";
import path from "node:path";
import type { PluginOperationalReport } from "@sentry/junior-plugin-api";

export type {
  PluginConversationStatus,
  PluginConversations,
  PluginConversationSummary,
} from "@sentry/junior-plugin-api";

export interface HealthReport {
  status: "ok";
  service: string;
  timestamp: string;
}

export interface PluginReport {
  name: string;
}

export interface SkillReport {
  name: string;
  pluginProvider?: string;
}

export interface RuntimeInfoReport {
  cwd: string;
  homeDir: string;
  descriptionText?: string;
  providers: string[];
  skills: SkillReport[];
  packagedContent: PluginPackageContentReport;
}

export interface PluginPackageContentItemReport {
  dir: string;
  hasMigrationsDir: boolean;
  hasSkillsDir: boolean;
  packageName: string;
}

export interface PluginPackageContentReport {
  packageNames: string[];
  packages: PluginPackageContentItemReport[];
  manifestRoots: string[];
  skillRoots: string[];
  tracingIncludes: string[];
}

export type { PluginOperationalReport } from "@sentry/junior-plugin-api";

export interface PluginOperationalReportFeed {
  generatedAt: string;
  reports: PluginOperationalReport[];
  source: "plugins";
}

export interface JuniorReporting {
  /** Read the public runtime health snapshot without exposing discovery data. */
  getHealth(): Promise<HealthReport>;
  /** Read authenticated runtime discovery data for reporting consumers. */
  getRuntimeInfo(): Promise<RuntimeInfoReport>;
  /** Read configured plugin names for reporting consumers. */
  getPlugins(): Promise<PluginReport[]>;
  /** Read discovered skill names for reporting consumers. */
  getSkills(): Promise<SkillReport[]>;
  /** Read sanitized operational summaries contributed by plugins. */
  getPluginOperationalReports(): Promise<PluginOperationalReportFeed>;
}

function readDescriptionText(home: string): string | undefined {
  try {
    const raw = readFileSync(path.join(home, "DESCRIPTION.md"), "utf8").trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

async function readHealth(): Promise<HealthReport> {
  const { GET: healthGET } = await import("@/handlers/health");
  const res = healthGET();
  return (await res.json()) as HealthReport;
}

async function readSkills(): Promise<SkillReport[]> {
  const { discoverSkills } = await import("@/chat/skills");
  const skills = await discoverSkills();
  return skills.map((skill) => ({
    name: skill.name,
    pluginProvider: skill.pluginProvider,
  }));
}

async function readPlugins(): Promise<PluginReport[]> {
  const { pluginCatalogRuntime } =
    await import("@/chat/plugins/catalog-runtime");
  return pluginCatalogRuntime.getProviders().map((plugin) => ({
    name: plugin.manifest.name,
  }));
}

/** Create the read-only reporting boundary used by plugins and other consumers. */
export function createJuniorReporting(): JuniorReporting {
  const listRecent = async (listOptions?: { limit?: number }) => {
    const { listRecentConversationSummaries } =
      await import("./reporting/plugin-conversations");
    return listRecentConversationSummaries(listOptions?.limit);
  };
  return {
    getHealth: readHealth,
    async getRuntimeInfo() {
      const [{ homeDir }, { pluginCatalogRuntime }, plugins, skills] =
        await Promise.all([
          import("@/chat/discovery"),
          import("@/chat/plugins/catalog-runtime"),
          readPlugins(),
          readSkills(),
        ]);
      const home = homeDir();

      return {
        cwd: process.cwd(),
        homeDir: home,
        descriptionText: readDescriptionText(home),
        providers: plugins.map((plugin) => plugin.name),
        skills,
        packagedContent: pluginCatalogRuntime.getPackageContent(),
      };
    },
    getPlugins: readPlugins,
    getSkills: readSkills,
    getPluginOperationalReports: async () => {
      const nowMs = Date.now();
      const { getPluginOperationalReports } =
        await import("@/chat/plugins/agent-hooks");
      return {
        source: "plugins",
        generatedAt: new Date(nowMs).toISOString(),
        reports: await getPluginOperationalReports(nowMs, {
          listRecent,
        }),
      };
    },
  };
}
