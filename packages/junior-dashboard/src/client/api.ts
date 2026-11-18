import { useEffect, useMemo, useRef } from "react";
import {
  keepPreviousData,
  queryOptions,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import type {
  ActorProfileReport,
  AutomationList,
  AutomationListItem,
  CodePersonReport,
} from "@sentry/junior/api/schema";
import type { LocationDetailReport } from "@sentry/junior/api/schema";
import {
  conversationFeedSchema,
  conversationStatsReportSchema,
  codeOverviewReportSchema,
  codePersonReportSchema,
  codeRepositoryReportSchema,
  cacheWarmingSavingsReportSchema,
  statsReportSchema,
} from "@sentry/junior/api/schema";
import {
  actorDirectoryReportSchema,
  actorProfileReportSchema,
  locationDetailReportSchema,
  locationDirectoryReportSchema,
  personalSpendReportSchema,
  automationExecutionListSchema,
  automationListPageSchema,
  automationListSchema,
  automationSummarySchema,
  automationRunListSchema,
  automationVersionListSchema,
} from "@sentry/junior/api/schema";
import { joinConversationFeedPages } from "./conversations/conversationFeedCache";
import {
  pluginOperationalReportFeedSchema,
  pluginsSchema,
  skillDetailReportSchema,
  skillReportsSchema,
} from "@sentry/junior/api/schema";
import {
  pluginUserPageLinksSchema,
  type CodeChangeState,
} from "@sentry/junior-plugin-api";

import {
  dashboardBootstrapSchema,
  dashboardConfigSchema,
  dashboardIdentitySchema,
} from "../api/schema";
import { usePinOrderSaving } from "./conversations/useReorderPinnedConversations";
import { fetchDashboardJson } from "./http";
import { useInboxUi } from "./uiShell";
import type { DashboardCoreData, SystemPluginsData } from "./types";

declare global {
  interface Window {
    __JUNIOR_DASHBOARD_BOOTSTRAP__?: unknown;
  }
}

const dashboardMetadataStaleTimeMs = 5 * 60_000;

// The shell embeds core data for the first read only. Taking it once means a
// later cache entry for the same key reads the API instead of stale data.
function takeDashboardBootstrap(): DashboardCoreData | undefined {
  if (typeof window === "undefined") return undefined;
  const embedded = window.__JUNIOR_DASHBOARD_BOOTSTRAP__;
  delete window.__JUNIOR_DASHBOARD_BOOTSTRAP__;
  const parsed = dashboardBootstrapSchema.safeParse(embedded);
  return parsed.success ? parsed.data : undefined;
}

/** Query options for dashboard shell data, seeded from the page shell. */
export function dashboardCoreQueryOptions() {
  return queryOptions({
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
    initialData: takeDashboardBootstrap,
    // The server built the embedded data while it served the page.
    initialDataUpdatedAt: () => performance.timeOrigin,
    retry: false,
    staleTime: dashboardMetadataStaleTimeMs,
  });
}

/** Fetch dashboard shell data shared across browser routes. */
export function useDashboardCoreData() {
  return useQuery(dashboardCoreQueryOptions());
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
export function useConversationsData(search = "") {
  const pinOrderSaving = usePinOrderSaving();
  // Only the new UI's rows show files and link cards, which cost the server
  // a query, so only it asks for them.
  const include = useInboxUi() && !search ? "links,media" : "";
  return useInfiniteQuery({
    // A read that ends during a Pinned order save can hold the old order.
    // The feed keeps its data and refetches when the save ends.
    enabled: !pinOrderSaving,
    queryKey: ["dashboard", "conversations", "viewer", { include, search }],
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams();
      if (search) params.set("q", search);
      if (include) params.set("include", include);
      if (pageParam) params.set("cursor", pageParam);
      const query = params.toString();
      return fetchDashboardJson(
        conversationFeedSchema,
        `/api/conversations${query ? `?${query}` : ""}`,
        signal,
      );
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    select: joinConversationFeedPages,
    placeholderData: keepPreviousData,
    // The versions poll refreshes the feed when it changes.
    retry: false,
  });
}

/** Fetch repository and code change analytics. */
export function useCodeOverviewData(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["dashboard", "code"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(codeOverviewReportSchema, "/api/code", signal),
    retry: false,
  });
}

/**
 * Fetch code activity, recent changes, and Workspaces for one repository.
 * `state` lists only the changes in that state.
 */
export function useCodeRepositoryData(
  repositoryId: string | undefined,
  state?: CodeChangeState,
) {
  return useQuery({
    enabled: Boolean(repositoryId),
    queryKey: ["dashboard", "code", "repositories", repositoryId, state],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        codeRepositoryReportSchema,
        `/api/code/repositories/${encodeURIComponent(repositoryId!)}${
          state ? `?state=${state}` : ""
        }`,
        signal,
      ),
    retry: false,
  });
}

/**
 * Fetch conversations linked to one repository through its code changes,
 * optionally matching `search` on the server.
 */
export function useCodeRepositoryConversationsData(
  repositoryId: string | undefined,
  search = "",
) {
  return useQuery({
    enabled: Boolean(repositoryId),
    queryKey: [
      "dashboard",
      "conversations",
      "code-repository",
      { repositoryId, search },
    ],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ codeRepositoryId: repositoryId! });
      if (search) params.set("q", search);
      return fetchDashboardJson(
        conversationFeedSchema,
        `/api/conversations?${params.toString()}`,
        signal,
      );
    },
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/**
 * Query keys for Automation reads. Every list shares one prefix and every
 * read of one Automation shares another, so a change refreshes the lists and
 * only the Automation that it changed.
 */
export const automationKeys = {
  lists: () => ["dashboard", "automations", "list"] as const,
  list: (search: string) => [...automationKeys.lists(), search] as const,
  activityPages: (search: string) =>
    [...automationKeys.lists(), "activity-pages", search] as const,
  runs: () => ["dashboard", "automations", "runs"] as const,
  one: (id: string | undefined) =>
    ["dashboard", "automations", "one", id] as const,
  detail: (id: string | undefined) =>
    [...automationKeys.one(id), "detail"] as const,
  edit: (id: string) => [...automationKeys.one(id), "edit"] as const,
  executions: (id: string | undefined) =>
    [...automationKeys.one(id), "executions"] as const,
  versions: (id: string | undefined) =>
    [...automationKeys.one(id), "versions"] as const,
};

/** Fetch the signed-in viewer's scheduled and event automations. */
export function useAutomationsData(enabled: boolean, search: string) {
  return useQuery({
    enabled,
    queryKey: automationKeys.list(search),
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        automationListSchema,
        `/api/automations${search ? `?${search}` : ""}`,
        signal,
      ),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/**
 * Page through the Automation list by `sort=activity`, as the new UI's
 * list scrolls. `automations` holds the rows of every loaded page.
 */
export function useAutomationPagesData(enabled: boolean, search: string) {
  const query = useInfiniteQuery({
    enabled,
    initialPageParam: "",
    queryKey: automationKeys.activityPages(search),
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams(search);
      params.set("sort", "activity");
      if (pageParam) params.set("cursor", pageParam);
      return fetchDashboardJson(
        automationListPageSchema,
        `/api/automations?${params.toString()}`,
        signal,
      );
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const pages = query.data?.pages;
  const automations = useMemo(
    () => (pages ?? []).flatMap((page) => page.automations),
    [pages],
  );
  return { automations, first: pages?.[0], query };
}

/**
 * Find a loaded list row for one Automation, so its page can show the
 * header before the summary arrives.
 */
export function useCachedAutomationListItem(
  id: string | undefined,
): AutomationListItem | undefined {
  const queryClient = useQueryClient();
  if (!id) return undefined;
  for (const [, data] of queryClient.getQueriesData<
    AutomationList | InfiniteData<AutomationList>
  >({ queryKey: automationKeys.lists() })) {
    const lists = data && "pages" in data ? data.pages : data ? [data] : [];
    for (const list of lists) {
      const found = list.automations?.find(
        (automation) => automation.id === id,
      );
      if (found) return found;
    }
  }
  return undefined;
}

function automationDetailQuery(id: string | undefined) {
  return queryOptions({
    queryKey: automationKeys.detail(id),
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        automationSummarySchema,
        `/api/automations/${encodeURIComponent(id!)}`,
        signal,
      ),
    retry: false,
  });
}

/** Load details by ID, independent of list filters and pagination. */
export function useAutomationData(enabled: boolean, id: string | undefined) {
  return useQuery({
    ...automationDetailQuery(id),
    enabled: enabled && Boolean(id),
  });
}

/** Fetch newest runs across all viewer-visible automations. */
export function useAutomationRunsData(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: automationKeys.runs(),
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        automationRunListSchema,
        "/api/automations/runs",
        signal,
      ),
    retry: false,
  });
}

/** Fetch terminal executions for one viewer-visible task. */
export function useAutomationExecutionsData(
  enabled: boolean,
  automationId: string | undefined,
) {
  return useQuery({
    ...automationExecutionsQuery(automationId),
    enabled: enabled && Boolean(automationId),
  });
}

function automationExecutionsQuery(automationId: string | undefined) {
  return queryOptions({
    queryKey: automationKeys.executions(automationId),
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        automationExecutionListSchema,
        `/api/automations/${encodeURIComponent(automationId!)}/executions`,
        signal,
      ),
    retry: false,
  });
}

// Long enough that a pointer moving across the list fetches nothing.
const HOVER_INTENT_MS = 150;

/**
 * Prefetch an Automation's summary and runs when the pointer rests on its
 * row or the row gets focus, so its page opens with data. Fresh reads are
 * not fetched again.
 */
export function usePrefetchAutomation(id: string) {
  const queryClient = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const start = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void queryClient.prefetchQuery(automationDetailQuery(id));
      void queryClient.prefetchQuery(automationExecutionsQuery(id));
    }, HOVER_INTENT_MS);
  };
  const cancel = () => clearTimeout(timer.current);
  return {
    onBlur: cancel,
    onFocus: start,
    // A tap opens the row at once, so a touch gives no time to prefetch.
    onPointerEnter: (event: { pointerType: string }) => {
      if (event.pointerType !== "touch") start();
    },
    onPointerLeave: cancel,
  };
}

/** Fetch saved definitions for one viewer-visible Automation, newest first. */
export function useAutomationVersionsData(
  enabled: boolean,
  automationId: string | undefined,
) {
  return useQuery({
    enabled: enabled && Boolean(automationId),
    queryKey: automationKeys.versions(automationId),
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        automationVersionListSchema,
        `/api/automations/${encodeURIComponent(automationId!)}/versions`,
        signal,
      ),
    retry: false,
  });
}

/** Fetch the actor directory used by the People dashboard route. */
export function useActorDirectoryData(enabled = true) {
  return useQuery({
    enabled,
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

/** Fetch person-scoped native code activity for one People profile. */
export function useActorCodeData(email: string | undefined) {
  return useQuery({
    enabled: Boolean(email),
    queryKey: ["dashboard", "people", email, "code"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        codePersonReportSchema,
        `/api/people/${encodeURIComponent(email!)}/code`,
        signal,
      ),
    retry: false,
  });
}

/**
 * Read every open code change of one person, a page of the code overview at
 * a time. Open changes list first, so paging stops at the first page that
 * reaches completed changes.
 */
export function useActorOpenCodeChanges(email: string | undefined) {
  return useInfiniteQuery({
    enabled: Boolean(email),
    queryKey: ["dashboard", "people", email, "code", "open"],
    queryFn: ({ pageParam, signal }) =>
      fetchDashboardJson(
        codePersonReportSchema,
        `/api/people/${encodeURIComponent(email!)}/code${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`,
        signal,
      ),
    // An empty cursor reads the first page.
    initialPageParam: "",
    getNextPageParam: (page: CodePersonReport) =>
      page.changes.at(-1)?.state === "open" ? page.nextCursor : undefined,
    retry: false,
  });
}

/**
 * Fetch the authenticated viewer's rolling model spend. The versions poll
 * refreshes it when it changes.
 */
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
    retry: false,
    staleTime: 0,
  });
}

/** Fetch the public location directory and private activity aggregate. */
export function useLocationDirectoryData(enabled = true) {
  return useQuery({
    enabled,
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
export function useSkillsData(options: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ["dashboard", "skills"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(skillReportsSchema, "/api/skills", signal),
    retry: false,
    staleTime: dashboardMetadataStaleTimeMs,
  });
}

/** Fetch one skill with its SKILL.md body. */
export function useSkillDetail(name: string) {
  return useQuery({
    queryKey: ["dashboard", "skills", name],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        skillDetailReportSchema,
        `/api/skills/${encodeURIComponent(name)}`,
        signal,
      ),
    retry: false,
    staleTime: dashboardMetadataStaleTimeMs,
  });
}

// Reports and conversation stats are aggregates that are slow to build and
// change slowly. Keep them across route changes and window focus.
const dashboardAggregateStaleTimeMs = 5 * 60_000;

/** Fetch operational plugin reports shown on the System Plugins pages. */
export function usePluginReportsData() {
  return useQuery({
    queryKey: ["dashboard", "plugin-reports"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        pluginOperationalReportFeedSchema,
        "/api/plugin-reports",
        signal,
      ),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: dashboardAggregateStaleTimeMs,
  });
}

/** Fetch conversation activity and model usage for the System overview. */
export function useConversationStatsData(options: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ["dashboard", "conversation-stats"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        conversationStatsReportSchema,
        "/api/conversations/stats",
        signal,
      ),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: dashboardAggregateStaleTimeMs,
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

/** Fetch what cache warming saved over the trailing UTC days of a range. */
export function useCacheWarmingSavings(days: number) {
  return useQuery({
    queryKey: ["dashboard", "cache-warming", "savings", days],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        cacheWarmingSavingsReportSchema,
        `/api/cache-warming/savings?days=${days}`,
        signal,
      ),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** Fetch the plugin inventory, skills, and operational reports. */
export function useSystemPluginsData() {
  const pluginsQuery = usePluginsData();
  const skillsQuery = useSkillsData();
  const pluginReportsQuery = usePluginReportsData();
  const dataReady = pluginsQuery.data && skillsQuery.data;
  return {
    data: dataReady
      ? ({
          pluginReportsError: Boolean(pluginReportsQuery.error),
          ...(pluginReportsQuery.data
            ? { pluginReports: pluginReportsQuery.data }
            : undefined),
          pluginReportsLoading: pluginReportsQuery.isPending,
          plugins: pluginsQuery.data,
          skills: skillsQuery.data,
        } satisfies SystemPluginsData)
      : undefined,
    error: pluginsQuery.error ?? skillsQuery.error,
  };
}
