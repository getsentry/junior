import { QueryClient, useQuery } from "@tanstack/react-query";

import type {
  ConversationStatsReport,
  ConversationDetailFeed,
  ConversationFeed,
  DashboardConfig,
  DashboardData,
  Health,
  Identity,
  Plugin,
  PluginReportFeed,
  Runtime,
  Skill,
} from "./types";

/** Share dashboard query cache between route data and tooltip detail lookups. */
export const client = new QueryClient();
type DashboardCoreData = Omit<
  DashboardData,
  | "conversations"
  | "conversationStats"
  | "conversationStatsError"
  | "conversationStatsLoading"
  | "pluginReports"
  | "pluginReportsError"
  | "pluginReportsLoading"
>;

class DashboardApiError extends Error {
  readonly status: number;

  constructor(path: string, status: number) {
    super(`${path} returned ${status}`);
    this.status = status;
  }
}

function restartDashboardSignIn(): void {
  if (typeof window === "undefined") {
    return;
  }

  const basePath = window.__JUNIOR_DASHBOARD_BASE_PATH__ ?? "/";
  const loginPath = basePath === "/" ? "/auth/login" : `${basePath}/auth/login`;
  if (window.location.pathname !== loginPath) {
    const returnPath = `${window.location.pathname}${
      window.location.search || ""
    }`;
    const loginParams = new URLSearchParams();
    if (returnPath !== "/") {
      loginParams.set("next", returnPath);
    }
    const loginSearch = loginParams.toString();
    window.location.assign(
      loginSearch ? `${loginPath}?${loginSearch}` : loginPath,
    );
  }
}

async function read<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin" });
  if (response.status === 401) {
    restartDashboardSignIn();
    throw new DashboardApiError(path, response.status);
  }
  if (!response.ok) throw new DashboardApiError(path, response.status);
  return (await response.json()) as T;
}

function emptyPluginReportFeed(): PluginReportFeed {
  return {
    generatedAt: new Date().toISOString(),
    reports: [],
    source: "plugins",
  };
}

function emptyConversationStatsReport(): ConversationStatsReport {
  const nowMs = Date.now();
  return {
    active: 0,
    conversations: 0,
    durationMs: 0,
    failed: 0,
    generatedAt: new Date(nowMs).toISOString(),
    hung: 0,
    locations: [],
    requesters: [],
    sampleLimit: 0,
    sampleSize: 0,
    source: "conversation_index",
    truncated: false,
    runs: 0,
    windowEnd: new Date(nowMs).toISOString(),
    windowStart: new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function emptyConversationFeed(): ConversationFeed {
  return {
    conversations: [],
    generatedAt: new Date().toISOString(),
    source: "conversation_index",
  };
}

async function readConversationFeed(): Promise<ConversationFeed> {
  return await read<ConversationFeed>("/api/conversations");
}

async function readConversationStats(): Promise<ConversationStatsReport> {
  return await read<ConversationStatsReport>("/api/conversations/stats");
}

async function readPluginReports(): Promise<PluginReportFeed> {
  return await read<PluginReportFeed>("/api/plugin-reports");
}

/** Fetch dashboard shell data shared across browser routes. */
export function useDashboardCoreData() {
  return useQuery({
    queryKey: ["dashboard", "core"],
    queryFn: async (): Promise<DashboardCoreData> => {
      const [health, runtime, plugins, skills, me, config] = await Promise.all([
        read<Health>("/api/health"),
        read<Runtime>("/api/runtime"),
        read<Plugin[]>("/api/plugins"),
        read<Skill[]>("/api/skills"),
        read<Identity>("/api/me"),
        read<DashboardConfig>("/api/config"),
      ]);
      return {
        config,
        health,
        runtime,
        plugins,
        skills,
        me,
      };
    },
    retry: false,
  });
}

/** Fetch the conversation summary feed used by list-oriented dashboard routes. */
export function useConversationsData() {
  return useQuery({
    queryKey: ["dashboard", "conversations"],
    queryFn: readConversationFeed,
    retry: false,
  });
}

/** Fetch dashboard data needed by command center and list-oriented routes. */
export function useDashboardData() {
  const coreQuery = useDashboardCoreData();
  const conversationsQuery = useConversationsData();
  const conversationStatsQuery = useQuery({
    queryKey: ["dashboard", "conversation-stats"],
    queryFn: readConversationStats,
    retry: false,
  });
  const pluginReportsQuery = useQuery({
    queryKey: ["dashboard", "plugin-reports"],
    queryFn: readPluginReports,
    retry: false,
  });
  return {
    ...coreQuery,
    data: coreQuery.data
      ? {
          ...coreQuery.data,
          conversationStats:
            conversationStatsQuery.data ?? emptyConversationStatsReport(),
          conversationStatsError: Boolean(conversationStatsQuery.error),
          conversationStatsLoading:
            conversationStatsQuery.isPending && !conversationStatsQuery.data,
          pluginReportsError: Boolean(pluginReportsQuery.error),
          pluginReports: pluginReportsQuery.data ?? emptyPluginReportFeed(),
          pluginReportsLoading:
            pluginReportsQuery.isPending && !pluginReportsQuery.data,
          conversations: conversationsQuery.data ?? emptyConversationFeed(),
        }
      : undefined,
    error: coreQuery.error ?? conversationsQuery.error,
  };
}

/** Fetch one conversation transcript while preserving route-level disabled state. */
export function useConversationData(conversationId: string | undefined) {
  return useQuery({
    enabled: Boolean(conversationId),
    queryKey: ["conversation", conversationId],
    queryFn: async (): Promise<ConversationDetailFeed> =>
      readConversationData(conversationId!),
    retry: false,
  });
}

/** Read one conversation transcript payload for dashboard-local detail views. */
export function readConversationData(
  conversationId: string,
): Promise<ConversationDetailFeed> {
  return read<ConversationDetailFeed>(
    `/api/conversations/${encodeURIComponent(conversationId)}`,
  );
}
