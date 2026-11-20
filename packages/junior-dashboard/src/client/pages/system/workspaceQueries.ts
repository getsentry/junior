import { useQuery } from "@tanstack/react-query";
import {
  workspaceListSchema,
  workspaceSchema,
} from "@sentry/junior/api/schema";

import { DashboardApiError, fetchDashboardJson } from "../../http";

export const workspacesQueryKey = ["dashboard", "workspaces"] as const;

/** Cache key for one Workspace detail read. */
export function workspaceQueryKey(workspaceId: string | undefined) {
  return ["dashboard", "workspace", workspaceId] as const;
}

/** Return a useful dashboard error message without exposing response details. */
export function readWorkspaceApiError(
  error: unknown,
  fallback: string,
): string {
  if (error instanceof DashboardApiError) {
    return error.apiError ?? fallback;
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

/** Load Workspace recipes, the default Sandbox size, and the baseline snapshot. */
export function useWorkspacesData() {
  return useQuery({
    queryKey: workspacesQueryKey,
    queryFn: ({ signal }) =>
      fetchDashboardJson(workspaceListSchema, "/api/workspaces", signal),
    retry: false,
  });
}

/** Load one Workspace recipe with its current snapshot, which the list omits. */
export function useWorkspaceData(workspaceId: string | undefined) {
  return useQuery({
    enabled: workspaceId !== undefined,
    queryKey: workspaceQueryKey(workspaceId),
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        workspaceSchema,
        `/api/workspaces/${encodeURIComponent(workspaceId!)}`,
        signal,
      ),
    retry: false,
  });
}
