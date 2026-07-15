import { QueryClient, useMutation, useQuery } from "@tanstack/react-query";
import type { ZodType } from "zod";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import type { ConversationSubagentTranscriptReport } from "@sentry/junior/api/schema";
import type { ActorProfileReport } from "@sentry/junior/api/schema";
import type { LocationDetailReport } from "@sentry/junior/api/schema";
import {
  conversationDetailReportSchema,
  conversationFeedSchema,
  conversationStatsReportSchema,
  conversationSubagentTranscriptReportSchema,
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
import type { DashboardCoreData, SystemData } from "./types";

/** Share dashboard query cache between route data and tooltip detail lookups. */
export const client = new QueryClient();
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

async function mutate(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, {
    body: JSON.stringify(body),
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  if (response.status === 401) restartDashboardSignIn();
  if (!response.ok) throw new DashboardApiError(path, response.status);
}

async function read<T>(schema: ZodType<T>, path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin" });
  if (response.status === 401) {
    restartDashboardSignIn();
    throw new DashboardApiError(path, response.status);
  }
  if (!response.ok) throw new DashboardApiError(path, response.status);
  return schema.parse(await response.json());
}

/** Fetch dashboard shell data shared across browser routes. */
export function useDashboardCoreData() {
  return useQuery({
    queryKey: ["dashboard", "core"],
    queryFn: async (): Promise<DashboardCoreData> => {
      const [me, config] = await Promise.all([
        read(dashboardIdentitySchema, "/api/me"),
        read(dashboardConfigSchema, "/api/config"),
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
      read(
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
    queryFn: () => read(actorDirectoryReportSchema, "/api/people"),
    retry: false,
  });
}

/** Fetch one actor profile for the People detail dashboard route. */
export function useActorProfileData(email: string | undefined) {
  return useQuery({
    enabled: Boolean(email),
    queryKey: ["dashboard", "people", email],
    queryFn: async (): Promise<ActorProfileReport> =>
      read(
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
    queryFn: () => read(locationDirectoryReportSchema, "/api/locations"),
    retry: false,
  });
}

/** Fetch operational detail for one persisted public location. */
export function useLocationDetailData(locationId: string | undefined) {
  return useQuery({
    enabled: Boolean(locationId),
    queryKey: ["dashboard", "locations", locationId],
    queryFn: async (): Promise<LocationDetailReport> =>
      read(
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
      read(conversationStatsReportSchema, "/api/conversations/stats"),
    retry: false,
  });
  const pluginsQuery = useQuery({
    queryKey: ["dashboard", "plugins"],
    queryFn: () => read(pluginReportsSchema, "/api/plugins"),
    retry: false,
  });
  const skillsQuery = useQuery({
    queryKey: ["dashboard", "skills"],
    queryFn: () => read(skillReportsSchema, "/api/skills"),
    retry: false,
  });
  const pluginReportsQuery = useQuery({
    queryKey: ["dashboard", "plugin-reports"],
    queryFn: () =>
      read(pluginOperationalReportFeedSchema, "/api/plugin-reports"),
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

/** Archive or restore one conversation and refresh dashboard caches. */
export function useArchiveConversation(conversationId: string) {
  return useMutation({
    mutationFn: (args: { archived: boolean; lastSeenAt: string }) =>
      mutate(
        `/api/conversations/${encodeURIComponent(conversationId)}/archive`,
        args,
      ),
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["dashboard", "conversations"] }),
        client.invalidateQueries({ queryKey: ["dashboard", "locations"] }),
        client.invalidateQueries({ queryKey: ["dashboard", "people"] }),
        client.invalidateQueries({
          queryKey: ["conversation", conversationId],
        }),
      ]);
    },
  });
}

/** Fetch one conversation transcript while preserving route-level disabled state. */
export function useConversationData(conversationId: string | undefined) {
  return useQuery({
    enabled: Boolean(conversationId),
    queryKey: ["conversation", conversationId],
    queryFn: async (): Promise<ConversationDetailReport> =>
      readConversationData(conversationId!),
    retry: false,
  });
}

/** Read one conversation transcript payload for dashboard-local detail views. */
export function readConversationData(
  conversationId: string,
): Promise<ConversationDetailReport> {
  return read(
    conversationDetailReportSchema,
    `/api/conversations/${encodeURIComponent(conversationId)}`,
  );
}

/** Fetch one child-agent transcript for the conversation detail drawer. */
export function useConversationSubagentTranscriptData(
  params:
    | {
        conversationId: string;
        subagentId: string;
      }
    | undefined,
) {
  return useQuery({
    enabled: Boolean(params),
    queryKey: [
      "conversation-subagent",
      params?.conversationId,
      params?.subagentId,
    ],
    queryFn: async (): Promise<ConversationSubagentTranscriptReport> => {
      const active = params!;
      return await read(
        conversationSubagentTranscriptReportSchema,
        `/api/conversations/${encodeURIComponent(
          active.conversationId,
        )}/subagents/${encodeURIComponent(active.subagentId)}`,
      );
    },
    retry: false,
  });
}
