import { useContext } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { peopleSearchReportSchema } from "@sentry/junior/api/schema";
import { ActorAvatar } from "../components/ActorAvatar";
import { MatchedLabel } from "../components/MatchedLabel";
import { fetchDashboardJson } from "../http";
import { ComposerMenu, type ComposerTypeahead } from "./ComposerMenu";
import { ComposerConversationContext } from "./ComposerMention";
import { mentionName } from "./composerMentionToken";
import { rankPeople } from "./composerPeopleSearch";

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
  const rows = query ? rankPeople(search.data?.people ?? [], query) : [];
  return (
    <ComposerMenu
      label="People"
      onSelect={(row) => props.typeahead.insert({ person: row.person })}
      // Only the API knows which names an earlier row matched.
      pending={search.isPlaceholderData || search.isLoading}
      rowKey={(row) => row.person.slackUserId}
      rows={rows}
      typeahead={props.typeahead}
    >
      {({ person, nameMatches }) => (
        <>
          <ActorAvatar
            imageUrl={person.avatarUrl}
            name={mentionName(person)}
            size="list"
          />
          <span className="min-w-0 truncate">
            <MatchedLabel label={mentionName(person)} matches={nameMatches} />
          </span>
        </>
      )}
    </ComposerMenu>
  );
}
