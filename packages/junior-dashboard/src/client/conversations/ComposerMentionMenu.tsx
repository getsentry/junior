import { useContext, useState } from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  conversationFeedSchema,
  peopleSearchReportSchema,
  type MessageAttachment,
} from "@sentry/junior/api/schema";
import { ActorAvatar } from "../components/ActorAvatar";
import { quickOpenMatch } from "../components/quickOpenMatch";
import { useDebouncedValue } from "../debouncedValue";
import { memoryPath } from "../format";
import { fetchDashboardJson } from "../http";
import { useSearchData } from "../search";
import { formatRelativeTime } from "../time";
import {
  ComposerMenu,
  ComposerMenuDetails,
  type ComposerMenuRow,
  type ComposerMenuSource,
  type ComposerTypeahead,
} from "./ComposerMenu";
import { ComposerConversationContext } from "./ComposerMention";
import { ReferenceIcon } from "./ComposerReference";
import { useConversationChildAgents } from "./ConversationChildAgents";
import { conversationDisplayState } from "./ConversationStateIcon";
import { formatAttachmentBytes } from "./TranscriptAttachment";
import { mentionName } from "./composerMentionToken";
import { rankPeople } from "./composerPeopleSearch";
import { linkLabel, type ComposerReference } from "./composerReferences";
import { conversationUrl } from "./conversationRoutes";
import {
  conversationDetailQueryKey,
  type ConversationSnapshot,
} from "./queries";

// A person who types a name waits for the next keystroke, not for fresh data.
const SEARCH_STALE_MS = 60_000;
// Each source shows at most this many rows.
const SOURCE_ROW_LIMIT = 8;
// A Conversation or memory search costs the server more than a people
// search.
const SERVER_SEARCH_DEBOUNCE_MS = 150;
const MEMORY_SOURCES = ["memories"] as const;

/**
 * Suggest what the reader can mention while they type `@name`: people,
 * their Conversations, this Conversation's Tasks and files, and memories,
 * under one heading each. A person sends as `<@U…>`, a Conversation, Task,
 * or memory as a labeled link, and a file as its name.
 */
export function ComposerMentionMenu(props: { typeahead: ComposerTypeahead }) {
  const query = props.typeahead.query?.trim() ?? "";
  const conversationId = useContext(
    ComposerConversationContext,
  )?.conversationId;
  const sources = [
    usePeopleSource(query, conversationId),
    useConversationSource(query, conversationId),
    useTaskSource(query, conversationId),
    useFileSource(query, conversationId),
    useMemorySource(query),
  ];
  return (
    <ComposerMenu
      label="Mentions"
      sources={query ? sources : []}
      typeahead={props.typeahead}
    />
  );
}

// In a Conversation, the API finds only people of its Slack workspace, so
// the mention reaches them there.
function usePeopleSource(
  query: string,
  conversationId: string | undefined,
): ComposerMenuSource {
  const search = useQuery({
    enabled: query.length > 0,
    placeholderData: keepPreviousData,
    queryKey: ["dashboard", "people", "search", conversationId, query],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        peopleSearchReportSchema,
        `/api/people/search?${new URLSearchParams({
          q: query,
          ...(conversationId ? { conversationId } : undefined),
        })}`,
        signal,
      ),
    staleTime: SEARCH_STALE_MS,
  });
  const stale = search.isPlaceholderData;
  return {
    pending: stale || search.isLoading,
    rows: rankPeople(search.data?.people ?? [], query).map(
      ({ person, nameMatches }) => ({
        key: `person:${person.slackUserId}`,
        group: "People",
        icon: (
          <ActorAvatar
            imageUrl={person.avatarUrl}
            name={mentionName(person)}
            size="list"
          />
        ),
        label: mentionName(person),
        labelMatches: nameMatches,
        details: (
          <ComposerMenuDetails
            meta={person.email}
            title={mentionName(person)}
          />
        ),
        insertion: { person },
        stale,
      }),
    ),
  };
}

// The viewer's Conversations, as the Conversations search finds them.
function useConversationSource(
  query: string,
  conversationId: string | undefined,
): ComposerMenuSource {
  const debounced = useDebouncedValue(query, SERVER_SEARCH_DEBOUNCE_MS);
  const search = useQuery({
    enabled: debounced.length > 0,
    placeholderData: keepPreviousData,
    queryKey: ["dashboard", "conversations", "composer-search", debounced],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        conversationFeedSchema,
        `/api/conversations?${new URLSearchParams({ q: debounced })}`,
        signal,
      ),
    staleTime: SEARCH_STALE_MS,
  });
  const stale = search.isPlaceholderData || debounced !== query;
  const rows = (search.data?.conversations ?? [])
    // A Conversation does not need a link to itself.
    .filter((row) => row.conversationId !== conversationId)
    .slice(0, SOURCE_ROW_LIMIT)
    .map((row): ComposerMenuRow => {
      const title = linkLabel(row.displayTitle) || row.conversationId;
      const reference: ComposerReference = {
        kind: "conversation",
        url: conversationUrl(row.conversationId),
        title,
        state: conversationDisplayState(row),
      };
      return {
        key: `conversation:${row.conversationId}`,
        group: "Conversations",
        icon: <ReferenceIcon reference={reference} />,
        label: title,
        labelMatches: quickOpenMatch(title, query)?.indices,
        details: (
          <ComposerMenuDetails
            body={row.summary ?? row.activityPreview?.text}
            icon={<ReferenceIcon reference={reference} />}
            meta={`Active ${formatRelativeTime(row.lastSeenAt)}`}
            title={title}
          />
        ),
        insertion: { reference },
        stale,
      };
    });
  return {
    pending: Boolean(query) && (stale || search.isLoading),
    rows,
  };
}

// Only this Conversation's Threads and Tasks. The list is short, so the
// browser filters it.
function useTaskSource(
  query: string,
  conversationId: string | undefined,
): ComposerMenuSource {
  // Fetch the list on the first `@`, not on every composer mount.
  const wanted = useLatch(query.length > 0);
  const agents = useConversationChildAgents(
    conversationId ?? "",
    Boolean(conversationId) && wanted,
  );
  const rows = (agents.data?.agents ?? [])
    .flatMap((agent) => {
      if (agent.redacted) return [];
      const title =
        linkLabel(agent.title ?? agent.name ?? agent.task ?? "") ||
        agent.conversationId;
      const match = quickOpenMatch(title, query);
      return match ? [{ agent, match, title }] : [];
    })
    .sort((left, right) => right.match.score - left.match.score)
    .slice(0, SOURCE_ROW_LIMIT)
    .map(({ agent, match, title }): ComposerMenuRow => {
      const reference: ComposerReference = {
        kind: "task",
        url: conversationUrl(agent.conversationId),
        title,
      };
      return {
        key: `task:${agent.conversationId}`,
        group: "Tasks",
        icon: <ReferenceIcon reference={reference} />,
        label: title,
        labelMatches: match.indices,
        details: (
          <ComposerMenuDetails
            body={agent.task}
            icon={<ReferenceIcon reference={reference} />}
            meta={`${agent.kind === "thread" ? "Thread" : "Task"} · ${agent.status}`}
            title={title}
          />
        ),
        insertion: { reference },
      };
    });
  return { pending: Boolean(query) && agents.isLoading, rows };
}

// Files already attached in this Conversation. The agent has them in its
// history, so a mention is the file name.
function useFileSource(
  query: string,
  conversationId: string | undefined,
): ComposerMenuSource {
  // The Conversation page keeps its detail fresh. The menu only reads it.
  const detail = useQueryClient().getQueryData<ConversationSnapshot>(
    conversationDetailQueryKey(conversationId),
  );
  if (!conversationId || !detail || !query) return { pending: false, rows: [] };
  const files = new Map<string, MessageAttachment>();
  for (const { data } of detail.events) {
    const attachments =
      data.type === "message" || data.type === "attachments_delivered"
        ? (data.attachments ?? [])
        : [];
    for (const file of attachments) {
      if (!files.has(file.id)) files.set(file.id, file);
    }
  }
  const rows = [...files.values()]
    .flatMap((file) => {
      const match = quickOpenMatch(file.filename, query);
      return match ? [{ file, match }] : [];
    })
    .sort((left, right) => right.match.score - left.match.score)
    .slice(0, SOURCE_ROW_LIMIT)
    .map(({ file, match }): ComposerMenuRow => {
      const reference: ComposerReference = {
        kind: "file",
        name: file.filename,
      };
      return {
        key: `file:${file.id}`,
        group: "Files",
        icon: <ReferenceIcon reference={reference} />,
        label: file.filename,
        labelMatches: match.indices,
        details: (
          <ComposerMenuDetails
            icon={<ReferenceIcon reference={reference} />}
            meta={`${file.contentType} · ${formatAttachmentBytes(file.bytes)}`}
            title={file.filename}
          />
        ),
        insertion: { reference },
      };
    });
  return { pending: false, rows };
}

// Active public memories, which every signed-in person can read. The agent
// gets the link of the memory page, labeled with the start of its text.
function useMemorySource(query: string): ComposerMenuSource {
  const debounced = useDebouncedValue(query, SERVER_SEARCH_DEBOUNCE_MS);
  const search = useSearchData(debounced, MEMORY_SOURCES);
  const stale = search.isPlaceholderData || debounced !== query;
  const rows = (search.data?.memories ?? []).map((memory): ComposerMenuRow => {
    const title = linkLabel(memory.title);
    const reference: ComposerReference = {
      kind: "memory",
      url: `${window.location.origin}${memoryPath(memory.id)}`,
      title,
    };
    return {
      key: `memory:${memory.id}`,
      group: "Memories",
      icon: <ReferenceIcon reference={reference} />,
      label: title,
      labelMatches: quickOpenMatch(title, query)?.indices,
      details: (
        <ComposerMenuDetails
          body={memory.title}
          icon={<ReferenceIcon reference={reference} />}
          title="Memory"
        />
      ),
      insertion: { reference },
      stale,
    };
  });
  return {
    pending: Boolean(query) && (stale || search.isLoading),
    rows,
  };
}

/** True from the first render where `value` is true. */
export function useLatch(value: boolean): boolean {
  const [latched, setLatched] = useState(value);
  if (value && !latched) setLatched(true);
  return latched || value;
}
