import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { peopleSearchReportSchema } from "@sentry/junior/api/schema";
import { ActorAvatar } from "../components/ActorAvatar";
import { fetchDashboardJson } from "../http";
import { ComposerMenu, type ComposerTypeahead } from "./ComposerMenu";
import { mentionName } from "./composerMentionToken";

// A person who types a name waits for the next keystroke, not for fresh data.
const PEOPLE_SEARCH_STALE_MS = 60_000;

/**
 * Suggest people while the reader types `@name`. A row inserts a mention
 * that the Message sends as `<@U…>`.
 */
export function ComposerPeopleMenu(props: { typeahead: ComposerTypeahead }) {
  const query = props.typeahead.query?.trim() ?? "";
  const search = useQuery({
    enabled: query.length > 0,
    placeholderData: keepPreviousData,
    queryKey: ["dashboard", "people", "search", query],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        peopleSearchReportSchema,
        `/api/people/search?q=${encodeURIComponent(query)}`,
        signal,
      ),
    staleTime: PEOPLE_SEARCH_STALE_MS,
  });
  const rows = query ? (search.data?.people ?? []) : [];
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
