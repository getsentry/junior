import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { codeChangeSearchReportSchema } from "@sentry/junior/api/schema";
import { useLocationDirectoryData } from "../api";
import { quickOpenMatch } from "../components/quickOpenMatch";
import { useDebouncedValue } from "../debouncedValue";
import {
  MessageObjectsProvider,
  useListedObjects,
} from "../display-text/DisplayText";
import { fetchDashboardJson } from "../http";
import { listedDraft } from "../listedCodeChange";
import { formatRelativeTime } from "../time";
import {
  ComposerMenu,
  ComposerMenuDetails,
  type ComposerMenuRow,
  type ComposerMenuSource,
  type ComposerTypeahead,
} from "./ComposerMenu";
import { useLatch } from "./ComposerMentionMenu";
import { ReferenceIcon, referenceName } from "./ComposerReference";
import { codeChangeTone } from "./ConversationMeta";
import type { ComposerReference } from "./composerReferences";

// A person who types a name waits for the next keystroke, not for fresh data.
const SEARCH_STALE_MS = 60_000;
const CHANNEL_ROW_LIMIT = 8;
const CODE_CHANGE_SEARCH_DEBOUNCE_MS = 150;

/**
 * Suggest pull requests and Slack channels while the reader types `#name`.
 * A pull request sends as a link labeled `owner/repo#123`, and a channel as
 * `<#C…|name>`.
 */
export function ComposerHashMenu(props: { typeahead: ComposerTypeahead }) {
  // The rows read their live cards in one request.
  return (
    <MessageObjectsProvider>
      <HashMenu typeahead={props.typeahead} />
    </MessageObjectsProvider>
  );
}

function HashMenu(props: { typeahead: ComposerTypeahead }) {
  const query = props.typeahead.query?.trim() ?? "";
  const sources = [useCodeChangeSource(query), useChannelSource(query)];
  return (
    <ComposerMenu
      label="References"
      sources={query ? sources : []}
      typeahead={props.typeahead}
    />
  );
}

// Pull requests that Junior tracks, by number, title, or repository.
function useCodeChangeSource(query: string): ComposerMenuSource {
  const debounced = useDebouncedValue(query, CODE_CHANGE_SEARCH_DEBOUNCE_MS);
  const search = useQuery({
    enabled: debounced.length > 0,
    placeholderData: keepPreviousData,
    queryKey: ["dashboard", "code", "changes", "search", debounced],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        codeChangeSearchReportSchema,
        `/api/code/changes/search?${new URLSearchParams({ q: debounced })}`,
        signal,
      ),
    staleTime: SEARCH_STALE_MS,
  });
  const stale = search.isPlaceholderData || debounced !== query;
  const changes = search.data?.changes ?? [];
  // Only an open change can be a draft, so only it needs its live card.
  const listedOf = useListedObjects(
    changes.flatMap((change) => (change.state === "open" ? change.url : [])),
  );
  const rows = changes.map((change): ComposerMenuRow => {
    const listed = listedOf(change.url);
    const draft = listedDraft(listed);
    const reference: ComposerReference = {
      kind: "code_change",
      url: change.url,
      repository: change.repository,
      number: change.number,
      state: change.state,
      draft,
    };
    const label = referenceName(reference);
    return {
      key: `code_change:${change.url}`,
      group: "Pull requests",
      icon: <ReferenceIcon reference={reference} />,
      label,
      hint: change.title ?? undefined,
      details: (
        <ComposerMenuDetails
          icon={<ReferenceIcon reference={reference} />}
          meta={`${label} · ${codeChangeTone(change.state, draft).label}`}
          title={change.title ?? label}
        />
      ),
      insertion: { reference },
      // An open change goes in with its draft state, so it waits for its
      // card.
      stale: stale || (change.state === "open" && !listed.settled),
    };
  });
  return { pending: Boolean(query) && (stale || search.isLoading), rows };
}

// Slack channels that Junior worked in. Locations have no Slack workspace,
// so a channel of another workspace can show too.
function useChannelSource(query: string): ComposerMenuSource {
  // Fetch the directory on the first `#`, not on every composer mount.
  const wanted = useLatch(query.length > 0);
  const directory = useLocationDirectoryData(wanted);
  const rows = (directory.data?.locations ?? [])
    .flatMap((location) => {
      if (
        location.provider !== "slack" ||
        location.kind !== "channel" ||
        !location.label.startsWith("#")
      ) {
        return [];
      }
      const match = quickOpenMatch(location.label.slice(1), query);
      return match ? [{ location, match }] : [];
    })
    .sort((left, right) => right.match.score - left.match.score)
    .slice(0, CHANNEL_ROW_LIMIT)
    .map(({ location, match }): ComposerMenuRow => {
      const reference: ComposerReference = {
        kind: "channel",
        channelId: location.providerDestinationId,
        name: location.label.slice(1),
      };
      return {
        key: `channel:${location.id}`,
        group: "Channels",
        icon: null,
        label: location.label,
        // The label starts with `#`, which the query does not have.
        labelMatches: match.indices.map((index) => index + 1),
        details: (
          <ComposerMenuDetails
            meta={`${location.conversations} conversations · active ${formatRelativeTime(location.lastSeenAt)}`}
            title={location.label}
          />
        ),
        insertion: { reference },
      };
    });
  return { pending: Boolean(query) && directory.isLoading, rows };
}
