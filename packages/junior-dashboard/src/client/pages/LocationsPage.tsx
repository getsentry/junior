import { Hash, LockKeyhole, MapPin } from "lucide-react";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type {
  ConversationStatsItem,
  LocationDetailReport,
  LocationDirectoryReport,
  LocationSummaryReport,
} from "@sentry/junior/api/schema";

import { useLocationDetailData, useLocationDirectoryData } from "../api";
import { Button } from "../components/Button";
import { ConversationList } from "../components/ConversationList";
import { ConversationSearchInput } from "../components/ConversationListControls";
import { ContributionGrid } from "../components/ContributionGrid";
import { EmptyTelemetry } from "../components/EmptyTelemetry";
import { LoadingView } from "../components/LoadingView";
import { Section } from "../components/Section";
import { SectionHeader } from "../components/SectionHeader";
import { SectionTitle } from "../components/SectionTitle";
import {
  buildConversations,
  filterConversationList,
  formatCompactNumber,
  formatMs,
  formatRelativeTime,
  formatTime,
  locationPath,
  peoplePath,
} from "../format";

type LocationSort = "conversations" | "recent" | "runtime" | "tokens";

/** Render the searchable directory of persisted public conversation locations. */
export function LocationsPage() {
  const query = useLocationDirectoryData();
  return <LocationsPageContent data={query.data} error={query.error} />;
}

/** Render loaded, failed, and empty public-location directory states. */
export function LocationsPageContent(props: {
  data: LocationDirectoryReport | undefined;
  error: unknown;
}) {
  const [params, setParams] = useSearchParams();
  const [sort, setSort] = useState<LocationSort>("recent");
  const search = params.get("q") ?? "";
  if (!props.data && !props.error) {
    return <LoadingView label="Loading locations" />;
  }
  const locations = filterLocations(props.data?.locations ?? [], search, sort);

  function setSearch(value: string) {
    const next = new URLSearchParams(params);
    if (value.trim()) next.set("q", value);
    else next.delete("q");
    setParams(next, { replace: true });
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-screen-xl px-4 py-4 md:px-8">
      <Section>
        <SectionHeader>
          <div>
            <SectionTitle>Locations</SectionTitle>
            <div className="mt-1 text-[0.82rem] leading-relaxed text-[#b8b8b8]">
              {props.data
                ? `${locations.length} of ${props.data.locations.length} public locations / ${formatCompactNumber(props.data.sampleSize)} sampled conversations`
                : "Locations failed to load"}
            </div>
          </div>
        </SectionHeader>
        {props.error ? (
          <div className="p-3">
            <EmptyTelemetry>
              {props.data
                ? "Location telemetry refresh failed. Showing cached data."
                : "Location telemetry is unavailable. Try refreshing the dashboard."}
            </EmptyTelemetry>
          </div>
        ) : null}
        {props.data ? (
          <>
            <LocationToolbar
              query={search}
              sort={sort}
              onQueryChange={setSearch}
              onSortChange={setSort}
            />
            <LocationDirectory locations={locations} />
          </>
        ) : null}
      </Section>
      {props.data && props.data.privateActivity.conversations > 0 ? (
        <PrivateActivity item={props.data.privateActivity} />
      ) : null}
    </div>
  );
}

function filterLocations(
  locations: LocationSummaryReport[],
  query: string,
  sort: LocationSort,
): LocationSummaryReport[] {
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? locations.filter((location) =>
        location.label.toLowerCase().includes(normalized),
      )
    : locations;
  return [...filtered].sort((left, right) => {
    if (sort === "conversations") {
      return right.conversations - left.conversations;
    }
    if (sort === "runtime") return right.durationMs - left.durationMs;
    if (sort === "tokens") return (right.tokens ?? 0) - (left.tokens ?? 0);
    return Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt);
  });
}

function LocationToolbar(props: {
  query: string;
  sort: LocationSort;
  onQueryChange(value: string): void;
  onSortChange(value: LocationSort): void;
}) {
  return (
    <div className="grid min-w-0 gap-2 border-b border-white/10 bg-[#050505] px-3 py-3 md:grid-cols-[minmax(14rem,1fr)_minmax(10rem,14rem)]">
      <ConversationSearchInput
        label="Search locations"
        placeholder="Search channel name..."
        value={props.query}
        onChange={props.onQueryChange}
      />
      <label className="grid h-9 min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center overflow-hidden rounded-md border border-white/15 bg-[#0b0b0b]">
        <span className="flex h-full items-center border-r border-white/10 px-2 text-[0.68rem] font-semibold uppercase text-[#777]">
          Sort
        </span>
        <select
          aria-label="Sort locations"
          className="h-full min-w-0 bg-transparent px-2 text-[0.82rem] font-semibold text-[#d6d6d6] outline-none"
          value={props.sort}
          onChange={(event) =>
            props.onSortChange(event.currentTarget.value as LocationSort)
          }
        >
          <option value="recent">Recently active</option>
          <option value="conversations">Most conversations</option>
          <option value="tokens">Most tokens</option>
          <option value="runtime">Most runtime</option>
        </select>
      </label>
    </div>
  );
}

function LocationDirectory(props: { locations: LocationSummaryReport[] }) {
  if (!props.locations.length) {
    return (
      <div className="p-3">
        <EmptyTelemetry>No public locations match this search.</EmptyTelemetry>
      </div>
    );
  }
  return (
    <div className="min-w-0" role="table">
      <div className="hidden grid-cols-[minmax(14rem,1fr)_minmax(21rem,auto)] gap-6 border-b border-white/10 bg-[#050505] px-3 py-2 text-[0.76rem] font-semibold uppercase text-[#888] md:grid">
        <div>Location</div>
        <div className="grid grid-cols-3 gap-3">
          <div className="text-right">Conversations</div>
          <div className="text-right">Tokens</div>
          <div className="text-right">Runtime</div>
        </div>
      </div>
      {props.locations.map((location) => (
        <Link
          className="grid min-w-0 grid-cols-1 gap-2 border-b border-l-4 border-b-white/10 border-l-[#beaaff] bg-[#0b0b0b] px-4 py-3 text-inherit no-underline transition-colors hover:bg-[#151515] md:grid-cols-[minmax(14rem,1fr)_minmax(21rem,auto)] md:items-center md:gap-6 md:px-3"
          key={location.id}
          to={locationPath(location.id)}
        >
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-8 shrink-0 place-items-center border border-white/10 bg-[#121018] text-[#beaaff]">
              <Hash aria-hidden="true" size={16} strokeWidth={2.2} />
            </span>
            <div className="min-w-0">
              <div className="truncate text-[1.02rem] font-bold text-white">
                {location.label}
              </div>
              <div className="mt-1 truncate text-[0.82rem] text-[#888]">
                Last active {formatRelativeTime(location.lastSeenAt)}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 text-[0.76rem] text-[#999] md:hidden">
            <span>{usageLabel(location.conversations, "conversation")}</span>
            <span aria-hidden="true" className="text-[#555]">
              ·
            </span>
            <span>{formatCompactNumber(location.tokens ?? 0)} tokens</span>
            <span aria-hidden="true" className="text-[#555]">
              ·
            </span>
            <span>{formatMs(location.durationMs)} runtime</span>
          </div>
          <div className="hidden grid-cols-3 gap-3 md:grid">
            <LocationValue
              value={formatCompactNumber(location.conversations)}
            />
            <LocationValue value={formatCompactNumber(location.tokens ?? 0)} />
            <LocationValue value={formatMs(location.durationMs)} />
          </div>
        </Link>
      ))}
    </div>
  );
}

function usageLabel(value: number, unit: string): string {
  return `${formatCompactNumber(value)} ${unit}${value === 1 ? "" : "s"}`;
}

function LocationValue(props: { value: string }) {
  return (
    <div className="min-w-0 truncate text-right font-semibold text-white">
      {props.value}
    </div>
  );
}

function PrivateActivity(props: { item: ConversationStatsItem }) {
  return (
    <Section className="border-white/10 opacity-75">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-3 px-4 py-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
        <span className="grid size-8 shrink-0 place-items-center border border-white/10 bg-[#101010] text-[#888]">
          <LockKeyhole aria-hidden="true" size={15} />
        </span>
        <div className="min-w-0">
          <div className="font-bold text-white">Private activity</div>
          <div className="mt-1 text-[0.8rem] leading-relaxed text-[#888]">
            DMs, private channels, and unknown visibility are combined and not
            linkable.
          </div>
        </div>
        <div className="col-start-2 text-left sm:col-start-auto sm:text-right">
          <div className="text-xl font-extrabold text-white">
            {formatCompactNumber(props.item.conversations)}
          </div>
          <div className="text-[0.68rem] font-semibold uppercase text-[#777]">
            conversations
          </div>
        </div>
      </div>
    </Section>
  );
}

/** Render operational activity for one persisted public location. */
export function LocationDetailPage() {
  const params = useParams();
  const locationId = params.locationId;
  const query = useLocationDetailData(locationId);
  return <LocationDetailPageContent data={query.data} error={query.error} />;
}

/** Render loaded, stale, failed, and loading public-location detail states. */
export function LocationDetailPageContent(props: {
  data: LocationDetailReport | undefined;
  error: unknown;
}) {
  if (!props.data && !props.error) {
    return <LoadingView label="Loading location" />;
  }
  return (
    <div className="mx-auto w-full min-w-0 max-w-screen-xl px-4 py-4 md:px-8">
      {props.error ? (
        <Section>
          <div className="p-3">
            <EmptyTelemetry>
              {props.data
                ? "Location telemetry refresh failed. Showing cached data."
                : "Location failed to load."}
            </EmptyTelemetry>
          </div>
        </Section>
      ) : null}
      {props.data ? <LocationDetail detail={props.data} /> : null}
    </div>
  );
}

function LocationDetail(props: { detail: LocationDetailReport }) {
  const detail = props.detail;
  const [search, setSearch] = useState("");
  const conversations = buildConversations(detail.recentConversations);
  const visible = filterConversationList(conversations, { query: search });
  return (
    <>
      <Section>
        <div className="flex min-w-0 items-center gap-3 border-b border-white/10 px-4 py-4">
          <span className="grid size-11 shrink-0 place-items-center border border-white/10 bg-[#121018] text-[#beaaff]">
            <MapPin aria-hidden="true" size={20} />
          </span>
          <div className="min-w-0">
            <h2 className="m-0 truncate text-2xl font-extrabold text-white">
              {detail.label}
            </h2>
            <div className="mt-1 text-[0.88rem] text-[#b8b8b8]">
              {detail.provider} public {detail.kind} /{" "}
              {detail.providerDestinationId} / last active{" "}
              {formatRelativeTime(detail.lastSeenAt)}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 border-b border-white/10 lg:grid-cols-4">
          <DetailMetric label="conversations" value={detail.conversations} />
          <DetailMetric label="people" value={detail.actors.length} />
          <DetailMetric label="tokens" value={detail.tokens ?? 0} />
          <DetailMetric label="runtime" value={formatMs(detail.durationMs)} />
        </div>
      </Section>

      <Section>
        <SectionHeader
          actions={
            <div className="text-[0.76rem] font-semibold uppercase text-[#888]">
              30 days
            </div>
          }
        >
          <SectionTitle>Activity</SectionTitle>
        </SectionHeader>
        <ContributionGrid days={detail.activityDays} />
      </Section>

      <Section>
        <SectionHeader>
          <SectionTitle>People</SectionTitle>
        </SectionHeader>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3">
          {detail.actors.slice(0, 9).map((item, index) => {
            const key = [
              item.actor.email,
              item.actor.slackUserId,
              item.actor.slackUserName,
              item.actor.fullName,
              index,
            ].join(":");
            const content = (
              <>
                <div className="truncate font-semibold text-white">
                  {item.label}
                </div>
                <div className="mt-1 text-[0.78rem] text-[#888]">
                  {formatCompactNumber(item.conversations)} conversations /{" "}
                  {formatMs(item.durationMs)}
                </div>
              </>
            );
            return item.actor.email ? (
              <Link
                className="min-w-0 border-b border-r border-white/10 px-4 py-3 text-inherit no-underline hover:bg-white/5"
                key={key}
                to={peoplePath(item.actor.email)}
              >
                {content}
              </Link>
            ) : (
              <div
                className="min-w-0 border-b border-r border-white/10 px-4 py-3"
                key={key}
              >
                {content}
              </div>
            );
          })}
        </div>
      </Section>

      <Section>
        <SectionHeader>
          <div>
            <SectionTitle>Recent conversations</SectionTitle>
            <div className="mt-1 text-[0.82rem] text-[#b8b8b8]">
              {visible.length} of {conversations.length} / generated{" "}
              {formatTime(detail.generatedAt)}
            </div>
          </div>
        </SectionHeader>
        <div className="grid gap-2 border-b border-white/10 bg-[#050505] px-3 py-3 md:grid-cols-[minmax(12rem,36rem)_auto]">
          <ConversationSearchInput
            label="Search location conversations"
            placeholder="Search title, person, or ID..."
            value={search}
            onChange={setSearch}
          />
          {search ? (
            <Button
              className="h-9 justify-center"
              onClick={() => setSearch("")}
            >
              Clear
            </Button>
          ) : null}
        </div>
        <ConversationList
          conversations={visible}
          emptyLabel="No conversations match this search."
        />
      </Section>
    </>
  );
}

function DetailMetric(props: { label: string; value: number | string }) {
  return (
    <div className="min-w-0 border-r border-t border-white/10 bg-[#050505] px-4 py-3">
      <div className="truncate text-2xl font-extrabold text-white">
        {typeof props.value === "number"
          ? formatCompactNumber(props.value)
          : props.value}
      </div>
      <div className="mt-1 text-[0.72rem] font-semibold uppercase text-[#888]">
        {props.label}
      </div>
    </div>
  );
}
