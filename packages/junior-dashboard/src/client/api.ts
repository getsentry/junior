import { QueryClient, useQuery } from "@tanstack/react-query";
import type { ZodType } from "zod";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import type { ConversationSubagentTranscriptReport } from "@sentry/junior/api/schema";
import type { ActorProfileReport } from "@sentry/junior/api/schema";
import {
  conversationDetailReportSchema,
  conversationFeedSchema,
  conversationStatsReportSchema,
  conversationSubagentTranscriptReportSchema,
} from "@sentry/junior/api/schema";
import {
  actorDirectoryReportSchema,
  actorProfileReportSchema,
} from "@sentry/junior/api/schema";
import {
  healthReportSchema,
  pluginOperationalReportFeedSchema,
  pluginReportsSchema,
  runtimeInfoReportSchema,
  skillReportsSchema,
} from "@sentry/junior/api/schema";

import { dashboardConfigSchema, dashboardIdentitySchema } from "../api/schema";
import type { DashboardData } from "./types";

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
      const [health, runtime, plugins, skills, me, config] = await Promise.all([
        read(healthReportSchema, "/api/health"),
        read(runtimeInfoReportSchema, "/api/runtime"),
        read(pluginReportsSchema, "/api/plugins"),
        read(skillReportsSchema, "/api/skills"),
        read(dashboardIdentitySchema, "/api/me"),
        read(dashboardConfigSchema, "/api/config"),
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
    queryFn: () => read(conversationFeedSchema, "/api/conversations"),
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

/** Fetch dashboard data needed by command center and list-oriented routes. */
export function useDashboardData() {
  const coreQuery = useDashboardCoreData();
  const conversationsQuery = useConversationsData();
  const conversationStatsQuery = useQuery({
    queryKey: ["dashboard", "conversation-stats"],
    queryFn: () =>
      read(conversationStatsReportSchema, "/api/conversations/stats"),
    retry: false,
  });
  const pluginReportsQuery = useQuery({
    queryKey: ["dashboard", "plugin-reports"],
    queryFn: () =>
      read(pluginOperationalReportFeedSchema, "/api/plugin-reports"),
    retry: false,
  });
  const dataReady = coreQuery.data && conversationsQuery.data;
  return {
    ...coreQuery,
    data: dataReady
      ? {
          ...coreQuery.data,
          ...(conversationStatsQuery.data
            ? { conversationStats: conversationStatsQuery.data }
            : {}),
          conversationStatsError: Boolean(conversationStatsQuery.error),
          conversationStatsLoading: conversationStatsQuery.isPending,
          pluginReportsError: Boolean(pluginReportsQuery.error),
          ...(pluginReportsQuery.data
            ? { pluginReports: pluginReportsQuery.data }
            : {}),
          pluginReportsLoading: pluginReportsQuery.isPending,
          conversations: conversationsQuery.data,
        }
      : undefined,
    error: coreQuery.error ?? conversationsQuery.error,
    isPending: coreQuery.isPending || conversationsQuery.isPending,
  };
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
