import { useQuery } from "@tanstack/react-query";
import type { ActorProfileReport } from "@sentry/junior/api/schema";
import type { LocationDetailReport } from "@sentry/junior/api/schema";
import {
  conversationFeedSchema,
  conversationStatsReportSchema,
} from "@sentry/junior/api/schema";
import {
  actorDirectoryReportSchema,
  actorProfileReportSchema,
  locationDetailReportSchema,
  locationDirectoryReportSchema,
} from "@sentry/junior/api/schema";
import {
  pluginOperationalReportFeedSchema,
  pluginReportsSchema,
  skillReportsSchema,
} from "@sentry/junior/api/schema";

import { dashboardConfigSchema, dashboardIdentitySchema } from "../api/schema";
import { fetchDashboardJson } from "./http";
import type { DashboardCoreData, SystemData } from "./types";

/** Fetch dashboard shell data shared across browser routes. */
export function useDashboardCoreData() {
  return useQuery({
    queryKey: ["dashboard", "core"],
    queryFn: async (): Promise<DashboardCoreData> => {
      const [me, config] = await Promise.all([
        fetchDashboardJson(dashboardIdentitySchema, "/api/me"),
        fetchDashboardJson(dashboardConfigSchema, "/api/config"),
      ]);
      return {
        config,
        me,
      };
    },
    retry: false,
  });
}

/** Fetch the conversation summary feed used by list-oriented dashboard routes. */
export function useConversationsData(actorEmail?: string) {
  const query = new URLSearchParams();
  if (actorEmail) query.set("actorEmail", actorEmail);
  const search = query.toString();
  return useQuery({
    queryKey: ["dashboard", "conversations", actorEmail ?? "all"],
    queryFn: () =>
      fetchDashboardJson(
        conversationFeedSchema,
        `/api/conversations${search ? `?${search}` : ""}`,
      ),
    retry: false,
  });
}

/** Fetch the actor directory used by the People dashboard route. */
export function useActorDirectoryData() {
  return useQuery({
    queryKey: ["dashboard", "people"],
    queryFn: () =>
      fetchDashboardJson(actorDirectoryReportSchema, "/api/people"),
    retry: false,
  });
}

/** Fetch one actor profile for the People detail dashboard route. */
export function useActorProfileData(email: string | undefined) {
  return useQuery({
    enabled: Boolean(email),
    queryKey: ["dashboard", "people", email],
    queryFn: async (): Promise<ActorProfileReport> =>
      fetchDashboardJson(
        actorProfileReportSchema,
        `/api/people/${encodeURIComponent(email!)}`,
      ),
    retry: false,
  });
}

/** Fetch the public location directory and private activity aggregate. */
export function useLocationDirectoryData() {
  return useQuery({
    queryKey: ["dashboard", "locations"],
    queryFn: () =>
      fetchDashboardJson(locationDirectoryReportSchema, "/api/locations"),
    retry: false,
  });
}

/** Fetch operational detail for one persisted public location. */
export function useLocationDetailData(locationId: string | undefined) {
  return useQuery({
    enabled: Boolean(locationId),
    queryKey: ["dashboard", "locations", locationId],
    queryFn: async (): Promise<LocationDetailReport> =>
      fetchDashboardJson(
        locationDetailReportSchema,
        `/api/locations/${encodeURIComponent(locationId!)}`,
      ),
    retry: false,
  });
}

/** Fetch aggregate system metrics, plugin inventory, and operational reports. */
export function useSystemData() {
  const coreQuery = useDashboardCoreData();
  const conversationStatsQuery = useQuery({
    queryKey: ["dashboard", "conversation-stats"],
    queryFn: () =>
      fetchDashboardJson(
        conversationStatsReportSchema,
        "/api/conversations/stats",
      ),
    retry: false,
  });
  const pluginsQuery = useQuery({
    queryKey: ["dashboard", "plugins"],
    queryFn: () => fetchDashboardJson(pluginReportsSchema, "/api/plugins"),
    retry: false,
  });
  const skillsQuery = useQuery({
    queryKey: ["dashboard", "skills"],
    queryFn: () => fetchDashboardJson(skillReportsSchema, "/api/skills"),
    retry: false,
  });
  const pluginReportsQuery = useQuery({
    queryKey: ["dashboard", "plugin-reports"],
    queryFn: () =>
      fetchDashboardJson(
        pluginOperationalReportFeedSchema,
        "/api/plugin-reports",
      ),
    retry: false,
  });
  const dataReady = coreQuery.data && pluginsQuery.data && skillsQuery.data;
  return {
    ...coreQuery,
    data: dataReady
      ? ({
          ...coreQuery.data,
          conversationStatsError: Boolean(conversationStatsQuery.error),
          ...(conversationStatsQuery.data
            ? { conversationStats: conversationStatsQuery.data }
            : {}),
          conversationStatsLoading: conversationStatsQuery.isPending,
          pluginReportsError: Boolean(pluginReportsQuery.error),
          ...(pluginReportsQuery.data
            ? { pluginReports: pluginReportsQuery.data }
            : {}),
          pluginReportsLoading: pluginReportsQuery.isPending,
          plugins: pluginsQuery.data,
          skills: skillsQuery.data,
        } satisfies SystemData)
      : undefined,
    error: coreQuery.error ?? pluginsQuery.error ?? skillsQuery.error,
    isPending:
      coreQuery.isPending || pluginsQuery.isPending || skillsQuery.isPending,
  };
}
