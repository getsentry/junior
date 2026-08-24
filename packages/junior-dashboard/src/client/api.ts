import { useQuery } from "@tanstack/react-query";
import type { ActorProfileReport } from "@sentry/junior/api/schema";
import type { LocationDetailReport } from "@sentry/junior/api/schema";
import {
  conversationFeedSchema,
  conversationStatsReportSchema,
  codeOverviewReportSchema,
  statsReportSchema,
} from "@sentry/junior/api/schema";
import {
  actorDirectoryReportSchema,
  actorProfileReportSchema,
  locationDetailReportSchema,
  locationDirectoryReportSchema,
  personalSpendReportSchema,
  taskExecutionListSchema,
  taskListSchema,
  taskRunListSchema,
} from "@sentry/junior/api/schema";
import {
  pluginOperationalReportFeedSchema,
  pluginsSchema,
  skillReportsSchema,
} from "@sentry/junior/api/schema";
import { pluginUserPageLinksSchema } from "@sentry/junior-plugin-api";

import { dashboardConfigSchema, dashboardIdentitySchema } from "../api/schema";
import { fetchDashboardJson } from "./http";
import type { DashboardCoreData, SystemData } from "./types";

const dashboardMetadataStaleTimeMs = 5 * 60_000;
const PERSONAL_SPEND_REFRESH_MS = 5 * 60_000;
const MIN_PERSONAL_SPEND_REFRESH_MS = 1_000;

/** Schedule the next spend refresh from the age of the server-cached report. */
export function personalSpendRefreshDelay(
  generatedAt: string | undefined,
  nowMs = Date.now(),
): number {
  if (!generatedAt) return PERSONAL_SPEND_REFRESH_MS;
  const generatedAtMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedAtMs)) return PERSONAL_SPEND_REFRESH_MS;
  const ageMs = Math.max(0, nowMs - generatedAtMs);
  return Math.max(
    MIN_PERSONAL_SPEND_REFRESH_MS,
    PERSONAL_SPEND_REFRESH_MS - ageMs,
  );
}

/** Fetch dashboard shell data shared across browser routes. */
export function useDashboardCoreData() {
  return useQuery({
    queryKey: ["dashboard", "core"],
    queryFn: async ({ signal }): Promise<DashboardCoreData> => {
      const [me, config] = await Promise.all([
        fetchDashboardJson(dashboardIdentitySchema, "/api/me", signal),
        fetchDashboardJson(dashboardConfigSchema, "/api/config", signal),
      ]);
      return {
        config,
        me,
      };
    },
    retry: false,
    staleTime: dashboardMetadataStaleTimeMs,
  });
}

/** Fetch safe plugin metadata used by dashboard navigation and System pages. */
export function usePluginsData() {
  return useQuery({
    queryKey: ["dashboard", "plugins"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(pluginsSchema, "/api/plugins", signal),
    retry: false,
    staleTime: dashboardMetadataStaleTimeMs,
  });
}

/** Fetch plugin-owned pages shown in dashboard navigation. */
export function usePluginUserPagesData() {
  return useQuery({
    queryKey: ["dashboard", "plugin-user-pages"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(pluginUserPageLinksSchema, "/api/user-pages", signal),
    retry: false,
    staleTime: dashboardMetadataStaleTimeMs,
  });
}

/** Fetch the conversation summary feed used by list-oriented dashboard routes. */
export function useConversationsData(status: "active" | "archived" = "active") {
  return useQuery({
    queryKey: ["dashboard", "conversations", "viewer", status],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        conversationFeedSchema,
        `/api/conversations${status === "archived" ? "?status=archived" : ""}`,
        signal,
      ),
    retry: false,
  });
}

/** Fetch repository and code change analytics. */
export function useCodeOverviewData() {
  return useQuery({
    queryKey: ["dashboard", "code"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(codeOverviewReportSchema, "/api/code", signal),
    retry: false,
  });
}

/** Fetch the signed-in viewer's scheduled and event tasks. */
export function useTasksData(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ["dashboard", "tasks"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(taskListSchema, "/api/tasks", signal),
    retry: false,
  });
}

/** Fetch newest runs across all viewer-visible tasks. */
export function useTaskRunsData(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ["dashboard", "tasks", "runs"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(taskRunListSchema, "/api/tasks/runs", signal),
    retry: false,
  });
}

/** Fetch terminal executions for one viewer-visible task. */
export function useTaskExecutionsData(
  enabled: boolean,
  kind: "scheduled" | "event" | undefined,
  taskId: string | undefined,
) {
  return useQuery({
    enabled: enabled && Boolean(kind && taskId),
    queryKey: ["dashboard", "tasks", kind, taskId, "executions"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        taskExecutionListSchema,
        `/api/tasks/${kind}/${encodeURIComponent(taskId!)}/executions`,
        signal,
      ),
    retry: false,
  });
}

/** Fetch the actor directory used by the People dashboard route. */
export function useActorDirectoryData() {
  return useQuery({
    queryKey: ["dashboard", "people"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(actorDirectoryReportSchema, "/api/people", signal),
    retry: false,
  });
}

/** Fetch one actor profile for the People detail dashboard route. */
export function useActorProfileData(email: string | undefined) {
  return useQuery({
    enabled: Boolean(email),
    queryKey: ["dashboard", "people", email],
    queryFn: async ({ signal }): Promise<ActorProfileReport> =>
      fetchDashboardJson(
        actorProfileReportSchema,
        `/api/people/${encodeURIComponent(email!)}`,
        signal,
      ),
    retry: false,
  });
}

/** Fetch person-scoped plugin reports for one People profile. */
export function useActorPluginReportsData(email: string | undefined) {
  return useQuery({
    enabled: Boolean(email),
    queryKey: ["dashboard", "people", email, "plugin-reports"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        pluginOperationalReportFeedSchema,
        `/api/people/${encodeURIComponent(email!)}/plugin-reports`,
        signal,
      ),
    retry: false,
  });
}

/** Fetch and refresh the authenticated viewer's rolling model spend. */
export function usePersonalSpendData(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ["dashboard", "personal-spend"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        personalSpendReportSchema,
        "/api/people/me/spend",
        signal,
      ),
    refetchInterval: (query) =>
      personalSpendRefreshDelay(query.state.data?.generatedAt),
    retry: false,
    staleTime: 0,
  });
}

/** Fetch the public location directory and private activity aggregate. */
export function useLocationDirectoryData() {
  return useQuery({
    queryKey: ["dashboard", "locations"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        locationDirectoryReportSchema,
        "/api/locations",
        signal,
      ),
    retry: false,
  });
}

/** Fetch operational detail for one persisted public location. */
export function useLocationDetailData(locationId: string | undefined) {
  return useQuery({
    enabled: Boolean(locationId),
    queryKey: ["dashboard", "locations", locationId],
    queryFn: async ({ signal }): Promise<LocationDetailReport> =>
      fetchDashboardJson(
        locationDetailReportSchema,
        `/api/locations/${encodeURIComponent(locationId!)}`,
        signal,
      ),
    retry: false,
  });
}

/** Fetch discovered skills used by System navigation and capability views. */
export function useSkillsData() {
  return useQuery({
    queryKey: ["dashboard", "skills"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(skillReportsSchema, "/api/skills", signal),
    retry: false,
    staleTime: dashboardMetadataStaleTimeMs,
  });
}

/** Fetch operational plugin reports used by System navigation and pages. */
export function usePluginReportsData() {
  return useQuery({
    queryKey: ["dashboard", "plugin-reports"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        pluginOperationalReportFeedSchema,
        "/api/plugin-reports",
        signal,
      ),
    retry: false,
  });
}

/** Fetch named daily counters used by Workspace usage charts. */
export function useStatsData() {
  return useQuery({
    queryKey: ["dashboard", "stats"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(statsReportSchema, "/api/stats", signal),
    retry: false,
  });
}

/** Fetch system metrics, plugin inventory, and operational reports. */
export function useSystemData(coreData: DashboardCoreData) {
  const pluginsQuery = usePluginsData();
  const conversationStatsQuery = useQuery({
    queryKey: ["dashboard", "conversation-stats"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        conversationStatsReportSchema,
        "/api/conversations/stats",
        signal,
      ),
    retry: false,
  });
  const skillsQuery = useSkillsData();
  const pluginReportsQuery = usePluginReportsData();
  const dataReady = pluginsQuery.data && skillsQuery.data;
  return {
    data: dataReady
      ? ({
          ...coreData,
          conversationStatsError: Boolean(conversationStatsQuery.error),
          ...(conversationStatsQuery.data
            ? { conversationStats: conversationStatsQuery.data }
            : undefined),
          conversationStatsLoading: conversationStatsQuery.isPending,
          pluginReportsError: Boolean(pluginReportsQuery.error),
          ...(pluginReportsQuery.data
            ? { pluginReports: pluginReportsQuery.data }
            : undefined),
          pluginReportsLoading: pluginReportsQuery.isPending,
          plugins: pluginsQuery.data,
          skills: skillsQuery.data,
        } satisfies SystemData)
      : undefined,
    error: pluginsQuery.error ?? skillsQuery.error,
    isPending: pluginsQuery.isPending || skillsQuery.isPending,
  };
}
