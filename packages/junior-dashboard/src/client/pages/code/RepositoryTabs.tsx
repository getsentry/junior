import { useDeferredValue, useEffect, useState } from "react";
import type { CodeRepositoryReport } from "@sentry/junior/api/schema";

import { useCodeRepositoryConversationsData } from "../../api";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { FilterTabList } from "../../components/FilterBar";
import {
  PagePagination,
  pageCount,
  pageItems,
} from "../../components/Pagination";
import { SearchInput } from "../../components/SearchInput";
import {
  timeRangeBucketUnit,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { ConversationHomeList } from "../../conversations/ConversationHomeList";
import { buildConversations, getDashboardTimeZone } from "../../format";
import { CodeActivityChart } from "./CodeActivityChart";
import { CodeChangeRow } from "./CodeChangeRow";
import { repositoryActivity } from "./RepositorySections";

const PAGE_SIZE = 25;
const noFinishedConversations = new Set<string>();

/** Conversations linked to the repository, in the home list layout. */
export function RepositoryConversationsTab(props: { repositoryId: string }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const search = useDeferredValue(query.trim());
  const feed = useCodeRepositoryConversationsData(props.repositoryId, search);
  const conversations = buildConversations(feed.data?.conversations ?? []);
  useEffect(() => {
    setPage(1);
  }, [search]);
  return (
    <section aria-label="Conversations" className="grid gap-3">
      <SearchInput
        className="w-full sm:ml-auto sm:w-72"
        label="Search conversations in this repository"
        onChange={setQuery}
        placeholder="Search conversations…"
        value={query}
      />
      {feed.error ? (
        <EmptyTelemetry>
          Conversations are unavailable. Try refreshing the dashboard.
        </EmptyTelemetry>
      ) : (
        <ConversationHomeList
          conversations={pageItems(conversations, page, PAGE_SIZE)}
          emptyLabel={
            search
              ? "No conversations match this search."
              : "No conversations are linked to this repository yet."
          }
          finishedConversationIds={noFinishedConversations}
          loading={!feed.data}
          timeZone={getDashboardTimeZone()}
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

/** Recent code changes in the repository, filtered by state and search. */
export function RepositoryChangesTab(props: {
  data: CodeRepositoryReport;
  range: TimeRangeDays;
}) {
  const [state, setState] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const all = props.data.changes;
  const needle = query.trim().toLowerCase();
  const changes = all.filter(
    (change) =>
      (!state || change.state === state) &&
      (!needle ||
        change.title?.toLowerCase().includes(needle) ||
        `#${change.number}`.includes(needle)),
  );
  const count = (value: string) =>
    all.filter((change) => change.state === value).length;
  useEffect(() => {
    setPage(1);
  }, [state, needle]);
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
              { count: all.length, label: "All", value: "" },
              { count: count("open"), label: "Open", value: "open" },
              { count: count("merged"), label: "Merged", value: "merged" },
              { count: count("closed"), label: "Closed", value: "closed" },
            ]}
            onChange={setState}
            value={state}
          />
          <SearchInput
            className="w-full max-w-md sm:w-auto"
            label="Search changes"
            onChange={setQuery}
            placeholder="Title or number"
            value={query}
          />
        </div>
        <Card>
          {changes.length === 0 ? (
            <div className="p-4">
              <EmptyTelemetry>No changes match these filters.</EmptyTelemetry>
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
