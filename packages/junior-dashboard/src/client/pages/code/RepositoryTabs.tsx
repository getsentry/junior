import { useEffect, useState } from "react";
import type { CodeRepositoryReport } from "@sentry/junior/api/schema";
import { codeChangeStateSchema } from "@sentry/junior-plugin-api";

import {
  useCodeRepositoryConversationsData,
  useCodeRepositoryData,
} from "../../api";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { FilterTabList } from "../../components/FilterBar";
import {
  PagePagination,
  pageCount,
  pageItems,
} from "../../components/Pagination";
import {
  timeRangeBucketUnit,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { ConversationHomeList } from "../../conversations/ConversationHomeList";
import { pinnedFirst } from "../../conversations/conversationSections";
import { buildConversations, getDashboardTimeZone } from "../../format";
import { useWaitingConversations } from "../../review-desk/queries";
import { CodeActivityChart } from "./CodeActivityChart";
import { CodeChangeRow } from "./CodeChangeRow";
import { repositoryActivity } from "./RepositorySections";

const PAGE_SIZE = 25;

/** Conversations linked to the repository, in the home list layout. */
export function RepositoryConversationsTab(props: { repositoryId: string }) {
  const [page, setPage] = useState(1);
  const feed = useCodeRepositoryConversationsData(props.repositoryId);
  const conversations = buildConversations(feed.data?.conversations ?? []);
  const waitingConversations = useWaitingConversations();
  return (
    <section aria-label="Conversations" className="grid gap-3">
      {feed.error ? (
        <EmptyTelemetry>
          Conversations are unavailable. Try refreshing the dashboard.
        </EmptyTelemetry>
      ) : (
        <ConversationHomeList
          conversations={pageItems(pinnedFirst(conversations), page, PAGE_SIZE)}
          emptyLabel="No conversations are linked to this repository yet."
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
export function RepositoryChangesTab(props: {
  data: CodeRepositoryReport;
  range: TimeRangeDays;
}) {
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
    <>
      <CodeActivityChart
        bucketUnit={timeRangeBucketUnit(props.range)}
        days={repositoryActivity(props.data, props.range)}
        range={props.range}
      />
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
          {changes.length === 0 ? (
            <div className="p-4">
              <EmptyTelemetry>
                {selectedState && stateQuery.error
                  ? "Changes are unavailable. Try refreshing the dashboard."
                  : selectedState && !stateQuery.data
                    ? "Loading changes…"
                    : "No changes match this state."}
              </EmptyTelemetry>
            </div>
          ) : (
            pageItems(changes, page, PAGE_SIZE).map((change) => (
              <CodeChangeRow change={change} key={change.id} />
            ))
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
    </>
  );
}
