import { readFileSync } from "node:fs";
import path from "node:path";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { getPluginOperationalReports } from "@/chat/plugins/agent-hooks";
import { discoverSkills } from "@/chat/skills";
import { homeDir } from "@/chat/discovery";
import { GET as healthGET } from "@/handlers/health";
import type { PluginOperationalReport } from "@sentry/junior-plugin-api";
import { getConversationStore } from "@/chat/db";
import {
  readConversationFeed,
  readConversationReport,
  readConversationSubagentTranscriptReport,
  readConversationStatsReport,
  listRecentConversationSummaries,
  type ConversationFeed,
  type PluginConversationSummary,
  type ConversationReport,
  type ConversationSubagentTranscriptReport,
  type ConversationStatsReport,
} from "./reporting/conversations";

export type {
  PluginConversationStatus,
  PluginConversations,
  PluginConversationSummary,
  ConversationActivityReport,
  ConversationActivityStatus,
  ConversationFeed,
  ConversationReport,
  ConversationReportStatus,
  ConversationRunReport,
  ConversationSubagentActivityReport,
  ConversationSubagentTranscriptReport,
  ConversationStatsItem,
  ConversationStatsReport,
  ConversationSummaryReport,
  ConversationSurface,
  ConversationToolActivityReport,
  ConversationUsage,
  ActorIdentity,
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
  /** List recent conversation summaries for reporting consumers. */
  listConversations(): Promise<ConversationFeed>;
  /** Read aggregate conversation stats for reporting consumers. */
  getConversationStats?(): Promise<ConversationStatsReport>;
  /** Read recent conversation summaries without transcript payloads. */
  listRecentConversations?(options?: {
    limit?: number;
  }): Promise<PluginConversationSummary[]>;
  /** Read sanitized operational summaries contributed by plugins. */
  getPluginOperationalReports?(): Promise<PluginOperationalReportFeed>;
  /**
   * Read one conversation transcript for reporting consumers.
   *
   * Transcript messages and activity steps come from SQL (`junior_agent_steps`
   * / `junior_conversation_messages`); the API should stay compatible with a
   * future Sentry trace-history source, so avoid fields that require store
   * internals.
   */
  getConversation(conversationId: string): Promise<ConversationReport>;
  /** Load a child-agent transcript only when an operator opens that subagent. */
  getConversationSubagentTranscript(
    conversationId: string,
    runId: string,
    subagentId: string,
  ): Promise<ConversationSubagentTranscriptReport>;
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
  return pluginCatalogRuntime.getProviders().map((plugin) => ({
    name: plugin.manifest.name,
  }));
}

/** Create the read-only reporting boundary used by plugins and other consumers. */
export function createJuniorReporting(): JuniorReporting & {
  getConversationStats(): Promise<ConversationStatsReport>;
  listRecentConversations(options?: {
    limit?: number;
  }): Promise<PluginConversationSummary[]>;
  getPluginOperationalReports(): Promise<PluginOperationalReportFeed>;
} {
  const conversationStore = getConversationStore();
  const listRecent = (listOptions?: { limit?: number }) =>
    listRecentConversationSummaries({
      ...listOptions,
      conversationStore,
    });
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
        packagedContent: pluginCatalogRuntime.getPackageContent(),
      };
    },
    getPlugins: readPlugins,
    getSkills: readSkills,
    listConversations: () => readConversationFeed({ conversationStore }),
    getConversationStats: () =>
      readConversationStatsReport({ conversationStore }),
    listRecentConversations: listRecent,
    getPluginOperationalReports: async () => {
      const nowMs = Date.now();
      return {
        source: "plugins",
        generatedAt: new Date(nowMs).toISOString(),
        reports: await getPluginOperationalReports(nowMs, {
          listRecent,
        }),
      };
    },
    getConversation: (conversationId) =>
      readConversationReport(conversationId, { conversationStore }),
    getConversationSubagentTranscript: (conversationId, runId, subagentId) =>
      readConversationSubagentTranscriptReport(
        conversationId,
        runId,
        subagentId,
      ),
  };
}
