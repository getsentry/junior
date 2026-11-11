import { pluginUserPageContentSchema } from "@sentry/junior-plugin-api";
import {
  keepPreviousData,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Brain,
  FolderGit2,
  GitPullRequest,
  History,
  MapPin,
  ScrollText,
  UserRound,
} from "lucide-react";

import {
  useActorDirectoryData,
  useAutomationRunsData,
  useCodeOverviewData,
  useCodeRepositoryData,
  useLocationDirectoryData,
} from "../api";
import {
  CONVERSATION_EVENT_PARAM,
  conversationPath,
} from "../conversations/conversationRoutes";
import { eventLogRows, filterEventLogRows } from "../conversations/eventLog";
import {
  conversationDetailQueryKey,
  type ConversationSnapshot,
} from "../conversations/queries";
import {
  buildConversationTranscript,
  type ConversationHistoryPage,
} from "../conversations/transcript";
import { locationPath, memoryPath, peoplePath } from "../format";
import { fetchDashboardJson } from "../http";
import { AUTOMATION_RUN_PARAM } from "../pages/automations/AutomationRunDetails";
import { codeRepositoryPath } from "../pages/code/codeRepositoryRoutes";
import {
  pluginUserPageApiPath,
  pluginUserPageRecordPath,
} from "../pages/user/pluginUserPageRoutes";
import type { DashboardHeaderNavItem } from "./layout/DashboardHeader";
import { navItemIcon } from "./layout/navIcons";
import { matchedItem, type PaletteItem } from "./paletteItem";

const LIMIT = 8;
const LABEL_LENGTH = 120;
const REPOSITORY_PATH = /^\/code\/([^/]+)/;

/** Directory groups by the nav item that shows their area. */
const AREA_KEYS = {
  Changes: "code",
  Locations: "system",
  Memories: "memory:memories",
  People: "system",
  Repositories: "code",
  Runs: "automations",
} as const;

/** The repository ID of the open repository page, if one shows. */
export function repositoryIdForPath(pathname: string): string | undefined {
  return REPOSITORY_PATH.exec(pathname)?.[1];
}

/** The directory group of the page that shows, which ranks first. */
export function directoryGroupForPath(pathname: string): string | undefined {
  if (pathname.startsWith("/system/people") || pathname.startsWith("/people/"))
    return "People";
  if (pathname.startsWith("/system/locations")) return "Locations";
  if (pathname === "/code") return "Repositories";
  if (REPOSITORY_PATH.test(pathname)) return "Changes";
  if (pathname === "/memories" || pathname.startsWith("/memories/"))
    return "Memories";
  if (pathname === "/automations/runs") return "Runs";
  return undefined;
}

/**
 * The group of the generic plugin page that shows: the page's label, from
 * its nav item. The memory library has its own route and group.
 */
export function pluginPageGroupForPath(
  navItems: readonly DashboardHeaderNavItem[],
  pathname: string,
): string | undefined {
  return navItems.find(
    (item) => item.to === pathname && pluginUserPageApiPath(item.to),
  )?.label;
}

/**
 * Rows from the dashboard's directories: People, Locations, Repositories,
 * the open repository's Changes, Memories, Runs, each generic plugin page,
 * and the open Conversation's Events. A directory reads only while there
 * is typed text or its page shows. Memories match on the server; the others
 * filter the list they load, as their pages did.
 */
export function useDirectoryPaletteItems(input: {
  activeGroup?: string;
  conversationId?: string;
  navItems: readonly DashboardHeaderNavItem[];
  pathname: string;
  /** Typed text, for lists the palette filters itself. */
  query: string;
  /** Debounced text, for server searches. */
  search: string;
}): PaletteItem[] {
  const query = input.query || undefined;
  const navKeys = new Set(input.navItems.map((item) => item.key));
  const wanted = (group: keyof typeof AREA_KEYS) =>
    navKeys.has(AREA_KEYS[group]) &&
    (Boolean(input.query) || input.activeGroup === group);
  // With no typed text, only the page's own directory shows.
  const rows = (group: string, items: (PaletteItem | undefined)[]) =>
    query || input.activeGroup === group
      ? items
          .filter((item): item is PaletteItem => Boolean(item))
          .sort((a, b) => b.score - a.score)
          .slice(0, LIMIT)
      : [];

  const people = useActorDirectoryData(wanted("People"));
  const locations = useLocationDirectoryData(wanted("Locations"));
  const repositories = useCodeOverviewData(wanted("Repositories"));
  const repositoryId = repositoryIdForPath(input.pathname);
  const repository = useCodeRepositoryData(
    wanted("Changes") ? repositoryId : undefined,
  );
  const runs = useAutomationRunsData(wanted("Runs"));
  const memories = useQuery({
    enabled: wanted("Memories"),
    queryKey: ["dashboard", "palette", "memories", input.search],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        pluginUserPageContentSchema,
        `/api/user-pages/memory/memories${input.search ? `?${new URLSearchParams({ q: input.search })}` : ""}`,
        signal,
      ),
    placeholderData: (previous) => previous,
    retry: false,
  });
  const memoriesCurrent =
    !memories.isPlaceholderData && input.query.trim() === input.search;
  const events = useEventItems(input.conversationId, input.query);
  const pluginPages = input.navItems.flatMap((item) => {
    const api = pluginUserPageApiPath(item.to);
    return api ? [{ ...item, api }] : [];
  });
  const pluginContents = useQueries({
    queries: pluginPages.map((page) => ({
      enabled: Boolean(input.query) || input.activeGroup === page.label,
      queryKey: ["dashboard", "palette", "plugin-page", page.key, input.search],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchDashboardJson(
          pluginUserPageContentSchema,
          `${page.api}${input.search ? `?${new URLSearchParams({ q: input.search })}` : ""}`,
          signal,
        ),
      placeholderData: keepPreviousData,
      retry: false,
    })),
  });

  return [
    ...rows(
      "People",
      (people.data?.people ?? []).map((person) =>
        matchedItem(
          {
            group: "People",
            icon: UserRound,
            id: `person-${person.actor.email}`,
            label:
              person.actor.fullName ??
              person.actor.slackUserName ??
              person.actor.email,
            meta: person.actor.email,
            to: peoplePath(person.actor.email),
          },
          query,
          [person.actor.email, person.actor.slackUserName],
        ),
      ),
    ),
    ...rows(
      "Locations",
      (locations.data?.locations ?? []).map((location) =>
        matchedItem(
          {
            group: "Locations",
            icon: MapPin,
            id: `location-${location.id}`,
            label: location.label,
            to: locationPath(location.id),
          },
          query,
        ),
      ),
    ),
    ...rows(
      "Repositories",
      (repositories.data?.repositories ?? []).map((item) =>
        matchedItem(
          {
            group: "Repositories",
            icon: FolderGit2,
            id: `repository-${item.id}`,
            label: item.name,
            to: codeRepositoryPath(item.id),
          },
          query,
        ),
      ),
    ),
    ...rows(
      "Changes",
      (repository.data?.changes ?? []).map((change) => {
        const url = change.url;
        if (!url) return undefined;
        return matchedItem(
          {
            group: "Changes",
            icon: GitPullRequest,
            id: `change-${change.id}`,
            label: change.title ?? `#${change.number}`,
            meta: `#${change.number}`,
            // A change row links to the change on its provider.
            run: () => window.open(url, "_blank", "noopener,noreferrer"),
          },
          query,
          [`#${change.number}`],
        );
      }),
    ),
    ...rows(
      "Memories",
      (memoriesCurrent ? (memories.data?.records ?? []) : []).map((record) => {
        const item = {
          group: "Memories",
          icon: Brain,
          id: `memory-${record.id}`,
          label: record.title.slice(0, LABEL_LENGTH),
          to: memoryPath(record.id),
        };
        // The server matched the text, so every row stays.
        return matchedItem(item, query) ?? { ...item, score: 1 };
      }),
    ),
    ...rows(
      "Runs",
      (runs.data?.runs ?? []).map((run) =>
        matchedItem(
          {
            group: "Runs",
            icon: History,
            id: `run-${run.executionId}`,
            label: run.title ?? run.automationTitle,
            meta: run.status,
            to: `/automations/runs?${new URLSearchParams({ [AUTOMATION_RUN_PARAM]: run.executionId })}`,
          },
          query,
          [run.automationTitle, run.status, run.kind, run.conversationId],
        ),
      ),
    ),
    ...rows("Events", events),
    // A plugin page's own rows, from the list its page reads. Picking one
    // opens the page at that row.
    ...pluginPages.flatMap((page, index) => {
      const content = pluginContents[index];
      const current =
        !content?.isPlaceholderData && input.query.trim() === input.search;
      return rows(
        page.label,
        (current ? (content?.data?.records ?? []) : []).map((record) => {
          const item = {
            group: page.label,
            icon: navItemIcon(page.key),
            id: `plugin-page-${page.key}-${record.id}`,
            label: record.title.slice(0, LABEL_LENGTH),
            to: pluginUserPageRecordPath(page.to, record.id),
          };
          // A page with a search placeholder matched the text on the
          // server, so its rows stay. Others match title and description.
          return content?.data?.searchPlaceholder
            ? (matchedItem(item, query) ?? { ...item, score: 1 })
            : matchedItem(item, query, [record.description]);
        }),
      );
    }),
  ];
}

/**
 * Events of the open Conversation that match the typed text, from the
 * events it has loaded. Picking one opens it in the event log.
 */
function useEventItems(
  conversationId: string | undefined,
  query: string,
): PaletteItem[] {
  const client = useQueryClient();
  const needle = query.trim().toLowerCase();
  if (!conversationId || !needle) return [];
  const detail = client.getQueryData<ConversationSnapshot>(
    conversationDetailQueryKey(conversationId),
  );
  if (!detail) return [];
  const history = client.getQueryData<{ pages: ConversationHistoryPage[] }>([
    "conversation",
    conversationId,
    "history",
    detail.eventHistory.status,
  ]);
  const events = buildConversationTranscript(
    detail,
    history?.pages ?? [],
  ).events;
  return filterEventLogRows(eventLogRows(events), needle).map((row) => ({
    group: "Events",
    icon: ScrollText,
    id: `event-${row.event.seq}`,
    label: `${row.event.data.type}: ${row.summary}`.slice(0, LABEL_LENGTH),
    meta: `#${row.event.seq}`,
    score: 1,
    to: `${conversationPath(conversationId)}?${new URLSearchParams({ [CONVERSATION_EVENT_PARAM]: String(row.event.seq) })}`,
  }));
}
