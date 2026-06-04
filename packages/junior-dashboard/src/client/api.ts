import { QueryClient, useQuery } from "@tanstack/react-query";

import type {
  ConversationDetailFeed,
  DashboardConfig,
  DashboardData,
  Health,
  Identity,
  Plugin,
  PluginDashboardReportFeed,
  Runtime,
  SessionFeed,
  Skill,
} from "./types";

/** Share dashboard query cache between route data and tooltip detail lookups. */
export const client = new QueryClient();
const CORE_DASHBOARD_REFETCH_INTERVAL_MS = 5_000;
const PLUGIN_REPORT_REFETCH_INTERVAL_MS = 30_000;

type DashboardCoreData = Omit<DashboardData, "pluginReports">;

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

  const loginPath = "/api/dashboard/login";
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

function emptyPluginReportFeed(): PluginDashboardReportFeed {
  return {
    generatedAt: new Date().toISOString(),
    reports: [],
    source: "trusted_plugins",
  };
}

async function readPluginReports(): Promise<PluginDashboardReportFeed> {
  try {
    return await read<PluginDashboardReportFeed>(
      "/api/dashboard/plugin-reports",
    );
  } catch (error) {
    if (error instanceof DashboardApiError && error.status === 401) {
      throw error;
    }
    return emptyPluginReportFeed();
  }
}

/** Poll the dashboard summary feed used by command center and conversation lists. */
export function useDashboardData() {
  const coreQuery = useQuery({
    queryKey: ["dashboard", "core"],
    queryFn: async (): Promise<DashboardCoreData> => {
      const [health, runtime, plugins, skills, sessions, me, config] =
        await Promise.all([
          read<Health>("/api/dashboard/health"),
          read<Runtime>("/api/dashboard/runtime"),
          read<Plugin[]>("/api/dashboard/plugins"),
          read<Skill[]>("/api/dashboard/skills"),
          read<SessionFeed>("/api/dashboard/sessions"),
          read<Identity>("/api/dashboard/me"),
          read<DashboardConfig>("/api/dashboard/config"),
        ]);
      return {
        config,
        health,
        runtime,
        plugins,
        skills,
        sessions,
        me,
      };
    },
    refetchInterval: CORE_DASHBOARD_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const pluginReportsQuery = useQuery({
    queryKey: ["dashboard", "plugin-reports"],
    queryFn: readPluginReports,
    refetchInterval: PLUGIN_REPORT_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
  return {
    ...coreQuery,
    data: coreQuery.data
      ? {
          ...coreQuery.data,
          pluginReports: pluginReportsQuery.data ?? emptyPluginReportFeed(),
        }
      : undefined,
    error: coreQuery.error,
  };
}

/** Poll one conversation transcript while preserving route-level disabled state. */
export function useConversationData(conversationId: string | undefined) {
  return useQuery({
    enabled: Boolean(conversationId),
    queryKey: ["conversation", conversationId],
    queryFn: async (): Promise<ConversationDetailFeed> =>
      readConversationData(conversationId!),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

/** Read one conversation transcript payload for dashboard-local detail views. */
export function readConversationData(
  conversationId: string,
): Promise<ConversationDetailFeed> {
  return read<ConversationDetailFeed>(
    `/api/dashboard/conversations/${encodeURIComponent(conversationId)}`,
  );
}
