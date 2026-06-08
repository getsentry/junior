import { readFileSync } from "node:fs";
import path from "node:path";
import {
  getPluginPackageContent,
  getPluginProviders,
} from "@/chat/plugins/registry";
import { getAgentPluginOperationalReports } from "@/chat/plugins/agent-hooks";
import { discoverSkills } from "@/chat/skills";
import { homeDir } from "@/chat/discovery";
import { GET as healthGET } from "@/handlers/health";
import type { PluginOperationalReport } from "@sentry/junior-plugin-api";
import {
  readConversationFeed,
  readConversationReport,
  readConversationStatsReport,
  type ConversationFeed,
  type ConversationReport,
  type ConversationStatsReport,
} from "./reporting/conversations";

export type {
  ConversationFeed,
  ConversationReport,
  ConversationReportStatus,
  ConversationRunReport,
  ConversationStatsItem,
  ConversationStatsReport,
  ConversationSummaryReport,
  ConversationSurface,
  ConversationUsage,
  RequesterIdentity,
  TranscriptMessage,
  TranscriptPart,
  TranscriptPartType,
  TranscriptRole,
} from "./reporting/conversations";

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
  hasSkillsDir: boolean;
  name: string;
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
  /** Read recent conversation summaries for reporting consumers. */
  getSessions(): Promise<ConversationFeed>;
  /** Read aggregate conversation stats for reporting consumers. */
  getConversationStats?(): Promise<ConversationStatsReport>;
  /** Read sanitized operational summaries contributed by plugins. */
  getPluginOperationalReports?(): Promise<PluginOperationalReportFeed>;
  /**
   * Read one conversation transcript for reporting consumers.
   *
   * The current implementation joins turn-session records with expiring session
   * logs, but the API should stay compatible with a future Sentry trace-history
   * source. Avoid adding fields that require Redis-only transcript internals.
   */
  getConversation(conversationId: string): Promise<ConversationReport>;
}

function readDescriptionText(): string | undefined {
  try {
    const raw = readFileSync(
      path.join(homeDir(), "DESCRIPTION.md"),
      "utf8",
    ).trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

async function readHealth(): Promise<HealthReport> {
  const res = healthGET();
  return (await res.json()) as HealthReport;
}

async function readSkills(): Promise<SkillReport[]> {
  const skills = await discoverSkills();
  return skills.map((skill) => ({
    name: skill.name,
    pluginProvider: skill.pluginProvider,
  }));
}

async function readPlugins(): Promise<PluginReport[]> {
  return getPluginProviders().map((plugin) => ({
    name: plugin.manifest.name,
  }));
}

async function readPluginOperationalReports(): Promise<PluginOperationalReportFeed> {
  const nowMs = Date.now();
  return {
    source: "plugins",
    generatedAt: new Date(nowMs).toISOString(),
    reports: await getAgentPluginOperationalReports(nowMs),
  };
}

/** Create the read-only reporting boundary used by plugins and other consumers. */
export function createJuniorReporting(): JuniorReporting & {
  getConversationStats(): Promise<ConversationStatsReport>;
  getPluginOperationalReports(): Promise<PluginOperationalReportFeed>;
} {
  return {
    getHealth: readHealth,
    async getRuntimeInfo() {
      const [plugins, skills] = await Promise.all([
        readPlugins(),
        readSkills(),
      ]);

      return {
        cwd: process.cwd(),
        homeDir: homeDir(),
        descriptionText: readDescriptionText(),
        providers: plugins.map((plugin) => plugin.name),
        skills,
        packagedContent: getPluginPackageContent(),
      };
    },
    getPlugins: readPlugins,
    getSkills: readSkills,
    getSessions: readConversationFeed,
    getConversationStats: readConversationStatsReport,
    getPluginOperationalReports: readPluginOperationalReports,
    getConversation: readConversationReport,
  };
}
