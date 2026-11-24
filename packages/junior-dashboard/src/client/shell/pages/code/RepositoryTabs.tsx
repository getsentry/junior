import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import type { CodeRepositoryReport } from "@sentry/junior/api/schema";
import { codeChangeStateSchema } from "@sentry/junior-plugin-api";

import {
  useCodeRepositoryConversationsData,
  useCodeRepositoryData,
} from "../../../api";
import { EmptyTelemetry } from "../../../components/EmptyTelemetry";
import { FilterTabList } from "../../../components/FilterBar";
import {
  PagePagination,
  pageCount,
  pageItems,
} from "../../../components/Pagination";
import { Card } from "../../../components/layout/Card";
import { Skeleton } from "../../../components/ui/skeleton";
import { ConversationHomeList } from "../../conversations/ConversationHomeList";
import { newestFirst } from "../../../conversations/conversationSections";
import { buildConversations } from "../../../format";
import {
  ConversationStateFilters,
  conversationStateOf,
  inConversationState,
  pinnedOnlyOf,
} from "../../../inbox/inboxFilters";
import { useWaitingConversations } from "../../../inbox/queries";
import { CodeChangeRows } from "../../../pages/code/CodeChangeRow";
import { getDashboardTimeZone } from "../../../time";

const PAGE_SIZE = 25;

/** Placeholder rows while a list of the repository loads. */
export function RepositoryRowsLoading(props: { label: string }) {
  return (
    <div aria-busy="true" className="grid" role="status">
      <span className="sr-only">{props.label}</span>
      {[0, 1, 2].map((row) => (
        <div
          className="grid gap-1.5 border-b border-dashboard-border-subtle px-4 py-3 last:border-b-0"
          key={row}
        >
          <Skeleton className={row % 2 ? "h-4 w-2/5" : "h-4 w-3/5"} />
          <Skeleton className="h-3 w-4/5 opacity-70" />
        </div>
      ))}
    </div>
  );
}

/**
 * Conversations linked to the repository, in the home list layout. A pin
 * stays in its time section. `?state=` shows the Conversations in one viewer
 * state, or `?pinned=1` only the viewer's pins, in one control.
 */
export function RepositoryConversationsTab(props: { repositoryId: string }) {
  const [page, setPage] = useState(1);
  const [params] = useSearchParams();
  const pinnedOnly = pinnedOnlyOf(params);
  const state = pinnedOnly ? "all" : conversationStateOf(params);
  useEffect(() => {
    setPage(1);
  }, [pinnedOnly, state]);
  const feed = useCodeRepositoryConversationsData(props.repositoryId);
  const waitingConversations = useWaitingConversations();
  const conversations = newestFirst(
    buildConversations(feed.data?.conversations ?? []),
  ).filter(
    (conversation) =>
      (!pinnedOnly || conversation.pinnedAt) &&
      inConversationState(
        conversation,
        waitingConversations.has(conversation.id),
        state,
      ),
  );
  return (
    <section aria-label="Conversations" className="grid gap-3">
      <div className="flex items-center justify-end gap-2">
        <ConversationStateFilters
          pinned={pinnedOnly}
          search={params.toString()}
          state={state}
        />
      </div>
      {feed.error ? (
        <EmptyTelemetry>
          Conversations are unavailable. Try refreshing the dashboard.
        </EmptyTelemetry>
      ) : (
        <ConversationHomeList
          conversations={pageItems(conversations, page, PAGE_SIZE)}
          emptyLabel={
            state !== "all"
              ? "No conversations match these filters."
              : pinnedOnly
                ? "Nothing pinned. Pin a conversation from its menu."
                : "No conversations are linked to this repository yet."
          }
          loading={!feed.data}
          timeZone={getDashboardTimeZone()}
          waitingConversations={waitingConversations}
        />
      )}
      <PagePagination
        className="pt-1"
        onPageChange={setPage}
        page={page}
        pageCount={pageCount(conversations.length, PAGE_SIZE)}
        pageSize={PAGE_SIZE}
        total={conversations.length}
      />
    </section>
  );
}

/**
 * Recent code changes in the repository, filtered by state. The command
 * palette finds a change.
 */
export function RepositoryChangesTab(props: { data: CodeRepositoryReport }) {
  const [state, setState] = useState("");
  const [page, setPage] = useState(1);
  // The report lists open changes first, up to its limit, so each state tab
  // loads its own changes. The counts cover every change.
  const selectedState = codeChangeStateSchema.safeParse(state).data;
  const stateQuery = useCodeRepositoryData(
    selectedState && props.data.repository.id,
    selectedState,
  );
  const changes = selectedState
    ? (stateQuery.data?.changes ?? [])
    : props.data.changes;
  const counts = props.data.changeCounts;
  useEffect(() => {
    setPage(1);
  }, [state]);
  return (
    <section aria-label="Changes" className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <FilterTabList
          ariaLabel="Change state"
          items={[
            {
              count: counts.open + counts.merged + counts.closed,
              label: "All",
              value: "",
            },
            { count: counts.open, label: "Open", value: "open" },
            { count: counts.merged, label: "Merged", value: "merged" },
            { count: counts.closed, label: "Closed", value: "closed" },
          ]}
          onChange={setState}
          value={state}
        />
      </div>
      <Card>
        {selectedState && !stateQuery.data && !stateQuery.error ? (
          <RepositoryRowsLoading label="Loading changes" />
        ) : changes.length === 0 ? (
          <div className="p-4">
            <EmptyTelemetry>
              {selectedState && stateQuery.error
                ? "Changes are unavailable. Try refreshing the dashboard."
                : "No changes match this state."}
            </EmptyTelemetry>
          </div>
        ) : (
          <CodeChangeRows changes={pageItems(changes, page, PAGE_SIZE)} />
        )}
      </Card>
      <PagePagination
        onPageChange={setPage}
        page={page}
        pageCount={pageCount(changes.length, PAGE_SIZE)}
        pageSize={PAGE_SIZE}
        total={changes.length}
      />
    </section>
  );
}
