import { useEffect, useMemo } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { ZodType } from "zod";
import type {
  ConversationDetailReport,
  ConversationEventPage,
  ConversationUpdatesReport,
} from "@sentry/junior/api/schema";
import type { ActorProfileReport } from "@sentry/junior/api/schema";
import type { LocationDetailReport } from "@sentry/junior/api/schema";
import {
  archiveConversationResponseSchema,
  conversationDetailReportSchema,
  conversationEventPageSchema,
  conversationFeedSchema,
  conversationStatsReportSchema,
  conversationUpdatesReportSchema,
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
import {
  buildConversationTranscript,
  conversationHistoryChanged,
} from "./conversation-transcript";
import type { DashboardCoreData, SystemData } from "./types";

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

async function mutate<T>(
  schema: ZodType<T>,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await fetch(path, {
    body: JSON.stringify(body),
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  if (response.status === 401) restartDashboardSignIn();
  if (!response.ok) throw new DashboardApiError(path, response.status);
  return schema.parse(await response.json());
}

async function read<T>(
  schema: ZodType<T>,
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
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
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { archived: boolean; lastSeenAt: string }) =>
      mutate(
        archiveConversationResponseSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/archive`,
        args,
      ),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["dashboard", "conversations"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["dashboard", "locations"],
        }),
        queryClient.invalidateQueries({ queryKey: ["dashboard", "people"] }),
        queryClient.invalidateQueries({
          exact: true,
          queryKey: ["conversation", conversationId, "detail"],
        }),
      ]);
    },
  });
}

/** Fetch one conversation transcript while preserving route-level disabled state. */
export function useConversationData(conversationId: string | undefined) {
  const detail = useQuery({
    enabled: Boolean(conversationId),
    queryKey: ["conversation", conversationId, "detail"],
    queryFn: ({ signal }) => readConversationData(conversationId!, signal),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const history = useInfiniteQuery({
    enabled: false,
    queryKey: [
      "conversation",
      conversationId,
      "history",
      detail.data?.previousCursor,
      detail.data?.eventHistory.status,
    ],
    queryFn: ({ pageParam, signal }) =>
      readConversationEvents(conversationId!, pageParam, signal),
    initialPageParam: detail.data?.previousCursor ?? "",
    getNextPageParam: (page) => page.previousCursor,
    retry: false,
  });
  const updates = useInfiniteQuery({
    enabled: Boolean(
      conversationId &&
      detail.data?.status === "active" &&
      detail.data.eventCursor,
    ),
    queryKey: [
      "conversation",
      conversationId,
      "updates",
      detail.data?.eventCursor,
      detail.data?.eventHistory.status,
      detail.data?.generatedAt,
    ],
    queryFn: ({ pageParam, signal }) =>
      readConversationUpdateBatch(conversationId!, pageParam, signal),
    initialPageParam: detail.data?.eventCursor ?? "",
    getNextPageParam: (page) =>
      page.status === "active" ? page.eventCursor : undefined,
    retry: false,
  });

  const historyPages = history.data?.pages ?? [];
  const updatePages = updates.data?.pages ?? [];
  const latestUpdate = updatePages.at(-1);
  const data = useMemo(
    () =>
      detail.data
        ? buildConversationTranscript(detail.data, historyPages, updatePages)
        : undefined,
    [detail.data, historyPages, updatePages],
  );
  const shouldRefreshDetail = Boolean(
    detail.data &&
    (conversationHistoryChanged(detail.data, historyPages, updatePages) ||
      isInvalidCursorError(history.error) ||
      isInvalidCursorError(updates.error)),
  );

  useEffect(() => {
    if (shouldRefreshDetail) void detail.refetch();
  }, [detail.refetch, shouldRefreshDetail]);

  useEffect(() => {
    if (
      (latestUpdate?.status ?? detail.data?.status) !== "active" ||
      updates.error ||
      !updates.hasNextPage
    ) {
      return undefined;
    }
    const interval = window.setInterval(() => {
      if (!updates.isFetchingNextPage) void updates.fetchNextPage();
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [
    detail.data?.status,
    latestUpdate?.status,
    updates.error,
    updates.fetchNextPage,
    updates.hasNextPage,
    updates.isFetchingNextPage,
  ]);

  return {
    ...detail,
    data,
    error: detail.error ?? updates.error,
    historyError: history.error,
    hasPreviousPage: history.data
      ? history.hasNextPage
      : Boolean(detail.data?.previousCursor),
    isLoadingPreviousPage: history.isFetchingNextPage,
    loadCompleteTranscript: async () => {
      if (!conversationId || !detail.data) {
        throw new Error("Cannot load a conversation without an id");
      }
      let pages = history.data?.pages ?? [];
      let hasNextPage = history.data
        ? history.hasNextPage
        : Boolean(detail.data.previousCursor);
      while (hasNextPage) {
        const result = await history.fetchNextPage();
        if (result.error) throw result.error;
        pages = result.data?.pages ?? pages;
        hasNextPage = result.hasNextPage;
      }
      let latestUpdates = updates.data?.pages;
      if ((latestUpdate?.status ?? detail.data.status) === "active") {
        const result = await updates.fetchNextPage();
        if (result.error) throw result.error;
        latestUpdates = result.data?.pages;
      }
      const complete = buildConversationTranscript(
        detail.data,
        pages,
        latestUpdates ?? [],
      );
      if (complete.previousCursor) {
        throw new Error("Conversation history did not finish loading");
      }
      return complete;
    },
    loadPreviousPage: () => {
      const hasPreviousPage = history.data
        ? history.hasNextPage
        : Boolean(detail.data?.previousCursor);
      if (conversationId && hasPreviousPage && !history.isFetchingNextPage) {
        void history.fetchNextPage();
      }
    },
  };
}

/** Read one conversation transcript payload for dashboard-local detail views. */
export function readConversationData(
  conversationId: string,
  signal?: AbortSignal,
): Promise<ConversationDetailReport> {
  return read(
    conversationDetailReportSchema,
    `/api/conversations/${encodeURIComponent(conversationId)}`,
    signal,
  );
}

/** Read one bounded page of events before the supplied history cursor. */
export function readConversationEvents(
  conversationId: string,
  before: string,
  signal?: AbortSignal,
): Promise<ConversationEventPage> {
  const query = new URLSearchParams({ before });
  return read(
    conversationEventPageSchema,
    `/api/conversations/${encodeURIComponent(conversationId)}/events?${query}`,
    signal,
  ).then((page) => {
    if (page.previousCursor === before) {
      throw new Error("Conversation history cursor did not advance");
    }
    return page;
  });
}

/** Read all forward pages from one stable detail cursor. */
export async function readConversationUpdateBatch(
  conversationId: string,
  initialCursor: string,
  signal?: AbortSignal,
): Promise<ConversationUpdatesReport> {
  const events = new Map<number, ConversationUpdatesReport["events"][number]>();
  const seenCursors = new Set<string>();
  let cursor = initialCursor;
  let latest: ConversationUpdatesReport | undefined;

  do {
    if (seenCursors.has(cursor)) {
      throw new Error("Conversation update cursor did not advance");
    }
    seenCursors.add(cursor);
    latest = await readConversationUpdates(conversationId, cursor, signal);
    for (const event of latest.events) events.set(event.seq, event);
    cursor = latest.eventCursor;
  } while (latest.hasMore);

  return {
    ...latest,
    events: [...events.values()].sort((left, right) => left.seq - right.seq),
  };
}

function isInvalidCursorError(error: Error | null): boolean {
  return error instanceof DashboardApiError && error.status === 400;
}

/** Read only canonical events appended after the supplied conversation cursor. */
export function readConversationUpdates(
  conversationId: string,
  cursor: string,
  signal?: AbortSignal,
): Promise<ConversationUpdatesReport> {
  const query = new URLSearchParams({ cursor });
  return read(
    conversationUpdatesReportSchema,
    `/api/conversations/${encodeURIComponent(conversationId)}/updates?${query}`,
    signal,
  );
}
