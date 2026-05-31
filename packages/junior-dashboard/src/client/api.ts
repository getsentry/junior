import { QueryClient, useQuery } from "@tanstack/react-query";

import type {
  ConversationDetailFeed,
  DashboardConfig,
  DashboardData,
  Health,
  Identity,
  Plugin,
  Runtime,
  SessionFeed,
  Skill,
} from "./types";

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

  const loginPath = "/api/dashboard/login";
  if (window.location.pathname !== loginPath) {
    window.location.assign(loginPath);
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

/** Poll the dashboard summary feed used by command center and conversation lists. */
export function useDashboardData() {
  return useQuery({
    queryKey: ["dashboard"],
    queryFn: async (): Promise<DashboardData> => {
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
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
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
