import { useState } from "react";
import { Clock3, Coins, Cpu, GitMerge } from "lucide-react";
import { Link } from "react-router";

import { ToggleButton } from "../../components/Button";
import { formatDuration } from "../../components/Duration";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import {
  FilterBar,
  FilterGroup,
  FilterTabList,
} from "../../components/FilterBar";
import {
  PagePagination,
  pageCount,
  pageItems,
} from "../../components/Pagination";
import { SearchInput } from "../../components/SearchInput";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { StatCard } from "../../components/metrics/StatCard";
import { ConversationHomeList } from "../../conversations/ConversationHomeList";
import { conversationPath } from "../../conversations/conversationRoutes";
import {
  automationPath,
  formatCompactNumber,
  formatCostSummary,
  getDashboardTimeZone,
  peoplePath,
} from "../../format";
import { CodeActivityChart } from "./CodeActivityChart";
import { CodeChangeRow } from "./CodeChangeRow";
import {
  RepositoryAutomationList,
  RepositorySection,
} from "./RepositorySections";
import { repositoryMock } from "./repositoryMock";

const repo = repositoryMock;
const PAGE_SIZE = 25;
const noFinishedConversations = new Set<string>();

function matches(query: string, ...fields: (string | undefined)[]): boolean {
  const needle = query.trim().toLowerCase();
  return (
    !needle || fields.some((field) => field?.toLowerCase().includes(needle))
  );
}

function usd(value: number): string {
  return formatCostSummary({ total: value });
}

/** Every conversation for the repository, in the home list layout. */
export function RepositoryConversationsTab() {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const conversations = repo.conversations.filter((conversation) =>
    matches(query, conversation.displayTitle, conversation.channelName),
  );
  return (
    <section aria-label="Conversations" className="grid gap-3">
      <SearchInput
        className="w-full sm:ml-auto sm:w-72"
        label="Search conversations in this repository"
        onChange={setQuery}
        placeholder="Search conversations…"
        value={query}
      />
      <ConversationHomeList
        conversations={pageItems(conversations, page, PAGE_SIZE)}
        finishedConversationIds={noFinishedConversations}
        timeZone={getDashboardTimeZone()}
      />
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

/** Every code change in the repository, filtered by state. */
export function RepositoryChangesTab(props: { range: TimeRangeDays }) {
  const [state, setState] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const changes = repo.changes.filter(
    (change) =>
      (!state || change.state === state) &&
      matches(query, change.title, `#${change.number}`),
  );
  return (
    <>
      <CodeActivityChart
        bucketUnit="day"
        days={repo.activityDays}
        range={props.range}
      />
      <section aria-label="Changes" className="grid gap-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <FilterTabList
            ariaLabel="Change state"
            items={[
              { count: repo.stats.created, label: "All", value: "" },
              { count: repo.stats.open, label: "Open", value: "open" },
              { count: repo.stats.merged, label: "Merged", value: "merged" },
              { count: repo.stats.closed, label: "Closed", value: "closed" },
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

const AUTOMATION_STATES = ["all", "active", "failing", "paused"] as const;
type AutomationState = (typeof AUTOMATION_STATES)[number];

/** Automations that act on the repository. Runs live on each automation. */
export function RepositoryAutomationsTab() {
  const [state, setState] = useState<AutomationState>("all");
  const [query, setQuery] = useState("");
  const automations = repo.automations.filter((automation) => {
    const failing = automation.lastRunStatus === "failed";
    const paused = automation.status === "paused";
    const inState =
      state === "all" ||
      (state === "failing" && failing) ||
      (state === "paused" && paused) ||
      (state === "active" && !failing && !paused);
    return inState && matches(query, automation.title, automation.createdBy);
  });
  return (
    <>
      <FilterBar
        search={{
          label: "Search automations",
          onChange: setQuery,
          placeholder: "Title or creator",
          value: query,
        }}
      >
        <FilterGroup label="State">
          {AUTOMATION_STATES.map((value) => (
            <ToggleButton
              key={value}
              onClick={() => setState(value)}
              pressed={state === value}
              variant="pill"
            >
              {value}
            </ToggleButton>
          ))}
        </FilterGroup>
      </FilterBar>
      <p className="m-0 border-b border-dashboard-border-subtle pb-3 text-sm text-dashboard-text-muted">
        {automations.length}{" "}
        {automations.length === 1 ? "automation" : "automations"}
      </p>
      {automations.length === 0 ? (
        <Card padding="md">
          <p className="m-0 text-sm text-dashboard-text-muted">
            No automations matched these filters.
          </p>
        </Card>
      ) : (
        <RepositoryAutomationList automations={automations} />
      )}
    </>
  );
}

/** Ranked spend rows in the person profile leaderboard layout. */
function UsageLeaderboard(props: {
  items: {
    detail?: string;
    key: string;
    label: string;
    to: string;
    value: number;
  }[];
  title: string;
}) {
  return (
    <RepositorySection title={props.title}>
      <ol className="m-0 list-none p-0">
        {props.items.map((item, index) => (
          <li
            className="border-b border-white/[0.06] last:border-b-0"
            key={item.key}
          >
            <Link
              className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-inherit no-underline transition-colors hover:bg-white/[0.03]"
              to={item.to}
            >
              <div className="font-mono text-xs leading-none text-dashboard-text-muted">
                {index + 1}
              </div>
              <div className="min-w-0">
                <div className="truncate font-display text-base font-medium leading-tight text-dashboard-text">
                  {item.label}
                </div>
                {item.detail ? (
                  <div className="mt-1 truncate font-mono text-xs leading-tight text-dashboard-text-muted">
                    {item.detail}
                  </div>
                ) : null}
              </div>
              <div className="font-display text-xl font-light leading-none text-dashboard-text">
                {usd(item.value)}
              </div>
            </Link>
          </li>
        ))}
      </ol>
    </RepositorySection>
  );
}

/** What drives Junior spend in the repository. */
export function RepositoryUsageTab() {
  const stats = repo.stats;
  const usage = repo.usage;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          detail="Conversations and automations"
          icon={Coins}
          label="Cost"
          value={usd(stats.costUsd)}
        />
        <StatCard
          detail="Persisted model token usage"
          icon={Cpu}
          label="Tokens"
          value={formatCompactNumber(stats.tokens)}
        />
        <StatCard
          detail="Cumulative conversation runtime"
          icon={Clock3}
          label="Runtime"
          value={formatDuration(stats.durationMs)}
        />
        <StatCard
          detail={`Across ${stats.merged} merged changes`}
          icon={GitMerge}
          label="Cost per merged change"
          value={usd(stats.perMergedChangeUsd)}
        />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <UsageLeaderboard
          items={usage.people.map((row) => ({
            detail: `${row.conversations} conversations`,
            key: row.actor.email,
            label: row.actor.fullName,
            to: peoplePath(row.actor.email),
            value: row.costUsd,
          }))}
          title="People"
        />
        <UsageLeaderboard
          items={usage.automations.map((row) => ({
            key: row.id,
            label: row.title,
            to: automationPath(row.id),
            value: row.costUsd,
          }))}
          title="Automations"
        />
        <UsageLeaderboard
          items={usage.conversations.map((row) => ({
            key: row.id,
            label: row.title,
            to: conversationPath(row.id),
            value: row.costUsd,
          }))}
          title="Conversations"
        />
      </div>
    </>
  );
}
