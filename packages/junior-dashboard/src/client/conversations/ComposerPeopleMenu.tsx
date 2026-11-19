import { useContext } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import {
  peopleSearchReportSchema,
  type MentionablePerson,
} from "@sentry/junior/api/schema";
import { ActorAvatar } from "../components/ActorAvatar";
import { fetchDashboardJson } from "../http";
import { ComposerMenu, type ComposerTypeahead } from "./ComposerMenu";
import { ComposerConversationContext } from "./ComposerMention";
import { mentionName } from "./composerMentionToken";

const WORD = /[\p{L}\p{N}]+/gu;

// A person who types a name waits for the next keystroke, not for fresh data.
const PEOPLE_SEARCH_STALE_MS = 60_000;

/**
 * Suggest people while the reader types `@name`. A row inserts a mention
 * that the Message sends as `<@U…>`. In a Conversation, the API finds only
 * people of its Slack workspace, so the mention reaches them there.
 */
export function ComposerPeopleMenu(props: { typeahead: ComposerTypeahead }) {
  const query = props.typeahead.query?.trim() ?? "";
  const conversationId = useContext(
    ComposerConversationContext,
  )?.conversationId;
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
    staleTime: PEOPLE_SEARCH_STALE_MS,
  });
  const people = query ? (search.data?.people ?? []) : [];
  // While the next search loads, keep only the earlier rows that still
  // match, so Enter cannot insert a person the text no longer names.
  const rows = search.isPlaceholderData
    ? people.filter((person) => matchesQuery(person, query))
    : people;
  return (
    <ComposerMenu
      label="People"
      onSelect={(person) => props.typeahead.insert({ person })}
      rowKey={(person) => person.slackUserId}
      rows={rows}
      typeahead={props.typeahead}
    >
      {(person) => (
        <>
          <ActorAvatar
            imageUrl={person.avatarUrl}
            name={mentionName(person)}
            size="list"
          />
          <span className="min-w-0 truncate">{mentionName(person)}</span>
        </>
      )}
    </ComposerMenu>
  );
}

// The API match: each word of the query starts a word of the name or the
// handle. A row that the API matched by another name hides only until the
// search returns.
function matchesQuery(person: MentionablePerson, query: string): boolean {
  const words = `${person.fullName ?? ""} ${person.slackUserName ?? ""}`
    .toLowerCase()
    .match(WORD);
  return (query.toLowerCase().match(WORD) ?? []).every((term) =>
    words?.some((word) => word.startsWith(term)),
  );
}
