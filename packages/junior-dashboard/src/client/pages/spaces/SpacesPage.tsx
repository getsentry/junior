import type {
  ConversationKindReport,
  SpaceDetailReport,
  SpaceFacts,
  SpaceSummary,
} from "@sentry/junior/api/schema";
import { ChevronRight, FolderTree, MessageSquarePlus, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useSpaceDetailData, useSpaceTreeData } from "../../api";
import { Button } from "../../components/Button";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { PageRouteLoading } from "../../components/PageRouteLoading";
import {
  conversationParticipants,
  ParticipantAvatarStack,
} from "../../components/ParticipantAvatarStack";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { NewConversationView } from "../../conversations/NewConversationView";
import { conversationPath } from "../../conversations/conversationRoutes";
import { useCreateConversation } from "../../conversations/queries";
import {
  buildConversations,
  formatCompactNumber,
  formatRelativeTime,
  slackLocationLabel,
} from "../../format";
import { cn } from "../../styles";
import { SpaceKindTag, SpacePill, spaceKindAccentClass } from "./SpaceKindTag";
import { spacePath } from "./spaceRoutes";

const DESCRIPTION =
  "Nested forum categories. Junior files each Conversation into one Space.";

/** Render the Spaces forum: the landing list or one Space. */
export function SpacesPage() {
  const { spaceId } = useParams();
  return spaceId ? (
    <SpaceDetail key={spaceId} spaceId={spaceId} />
  ) : (
    <SpaceLanding />
  );
}

function SpaceLanding() {
  const query = useSpaceTreeData();
  if (!query.data && !query.error) {
    return (
      <PageRouteLoading
        description={DESCRIPTION}
        label="Loading Spaces"
        title="Spaces"
        variant="list"
      />
    );
  }
  const topLevel = query.data?.spaces.filter(
    (space) => space.parentSpaceId === null,
  );
  return (
    <PageLayout>
      <PageHeader description={DESCRIPTION} title="Spaces" />
      {query.error ? (
        <EmptyTelemetry>
          Spaces are unavailable. Try refreshing the dashboard.
        </EmptyTelemetry>
      ) : null}
      {topLevel ? (
        <SpaceList
          emptyText="No Spaces yet. Junior creates them as it files Conversations, or run `junior spaces backfill`."
          spaces={topLevel}
          title="Spaces"
        />
      ) : null}
    </PageLayout>
  );
}

function SpaceDetail(props: { spaceId: string }) {
  const query = useSpaceDetailData(props.spaceId);
  const [composing, setComposing] = useState(false);
  const [filter, setFilter] = useState<SpaceFilter>({});
  if (!query.data && !query.error) {
    return (
      <PageRouteLoading
        description={DESCRIPTION}
        label="Loading Space"
        title="Spaces"
        variant="list"
      />
    );
  }
  if (!query.data) {
    return (
      <PageLayout>
        <PageHeader description={DESCRIPTION} title="Spaces" />
        <EmptyTelemetry>
          This Space is unavailable. It may have been archived.{" "}
          <Link className="text-cyan-100" to="/spaces">
            Back to Spaces
          </Link>
        </EmptyTelemetry>
      </PageLayout>
    );
  }
  const data = query.data;
  const conversations = data.conversations.filter(
    (conversation) =>
      (!filter.kind || conversation.kind === filter.kind) &&
      (!filter.channel ||
        channelKey(conversation.channelName) === filter.channel),
  );
  return (
    <PageLayout>
      <Breadcrumbs
        crumbs={[
          { label: "Spaces", to: "/spaces" },
          ...data.breadcrumbs.map((crumb) => ({
            label: crumb.name,
            to: spacePath(crumb.spaceId),
          })),
        ]}
        current={data.space.name}
      />
      <PageHeader
        actions={
          <Button
            aria-expanded={composing}
            onClick={() => setComposing((value) => !value)}
            tone={composing ? "default" : "primary"}
          >
            <MessageSquarePlus aria-hidden="true" className="size-4" />
            {composing ? "Cancel" : "New conversation"}
          </Button>
        }
        description={
          <SpaceStats
            participants={data.facts.participants}
            privateCount={data.privateConversationCount}
            space={data.space}
          />
        }
        title={data.space.name}
      />
      {composing ? (
        <SpaceComposer
          spaceId={data.space.spaceId}
          spaceName={data.space.name}
        />
      ) : null}
      {data.children.length > 0 ? (
        <SpaceList emptyText="" spaces={data.children} title="Spaces" />
      ) : null}
      <SpaceConversationList
        conversations={conversations}
        filter={filter}
        kinds={data.facts.kinds}
        onFilterChange={setFilter}
        privateCount={data.privateConversationCount}
      />
    </PageLayout>
  );
}

/** Start a Conversation that is pinned to this Space. */
function SpaceComposer(props: { spaceId: string; spaceName: string }) {
  const navigate = useNavigate();
  const createConversation = useCreateConversation();
  return (
    <Card as="section" className="p-4 sm:p-6">
      <NewConversationView
        error={
          createConversation.error
            ? "Could not create the conversation. Try again."
            : undefined
        }
        heading="Start a conversation"
        onSubmit={async (message, idempotencyKey, visibility, images) => {
          const accepted = await createConversation.mutateAsync({
            idempotencyKey,
            message,
            images,
            visibility,
            spaceId: props.spaceId,
          });
          navigate(conversationPath(accepted.conversationId));
        }}
        subheading={
          <SpacePill>
            <FolderTree aria-hidden="true" className="size-3" />
            in {props.spaceName}
          </SpacePill>
        }
      />
    </Card>
  );
}

function Breadcrumbs(props: {
  crumbs: Array<{ label: string; to: string }>;
  current: string;
}) {
  return (
    <nav
      aria-label="Space path"
      className="flex min-w-0 flex-wrap items-center gap-1 font-mono text-xs text-dashboard-text-muted"
    >
      {props.crumbs.map((crumb) => (
        <span className="flex items-center gap-1" key={crumb.to}>
          <Link
            className="text-inherit no-underline hover:text-cyan-100"
            to={crumb.to}
          >
            {crumb.label}
          </Link>
          <ChevronRight aria-hidden className="size-3" />
        </span>
      ))}
      <span aria-current="page" className="text-dashboard-text">
        {props.current}
      </span>
    </nav>
  );
}

function SectionTitle(props: { children: string }) {
  return (
    <div className="border-b border-dashboard-border-subtle px-4 py-3 font-display text-lg text-dashboard-text">
      {props.children}
    </div>
  );
}

type SpaceFilter = {
  kind?: ConversationKindReport;
  channel?: string;
};

/** One quiet line of Space stats, with the people who took part. */
function SpaceStats(props: {
  participants: SpaceFacts["participants"];
  privateCount: number;
  space: SpaceSummary;
}) {
  const { space } = props;
  const parts = [
    `${formatCompactNumber(space.totalConversationCount)} ${
      space.totalConversationCount === 1 ? "conversation" : "conversations"
    }`,
    props.privateCount > 0 ? `${props.privateCount} private` : undefined,
    space.lastActivityAt
      ? `active ${formatRelativeTime(space.lastActivityAt)}`
      : undefined,
  ].filter(Boolean);
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-dashboard-text-muted">
      <span>{parts.join(" · ")}</span>
      {props.participants.length > 0 ? (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true">·</span>
          <ParticipantAvatarStack
            participants={props.participants}
            size="list"
          />
          <span>
            {props.participants.length}{" "}
            {props.participants.length === 1 ? "person" : "people"}
          </span>
        </span>
      ) : null}
    </span>
  );
}

/** Toggle chip that filters the Conversation list. */
function FilterChip(props: {
  active: boolean;
  children: ReactNode;
  dimmed: boolean;
  label: string;
  onClick(): void;
}) {
  return (
    <button
      aria-label={props.label}
      aria-pressed={props.active}
      className={cn(
        "cursor-pointer rounded-full border-0 bg-transparent p-0 transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus",
        props.dimmed && "opacity-40 hover:opacity-80",
      )}
      onClick={props.onClick}
      type="button"
    >
      {props.children}
    </button>
  );
}

/**
 * Kind-of-work chips filter the list. A channel filter is set from a
 * Conversation row and shows here so a person can clear it.
 */
function SpaceFilters(props: {
  filter: SpaceFilter;
  kinds: SpaceFacts["kinds"];
  onChange(filter: SpaceFilter): void;
}) {
  const { filter } = props;
  if (props.kinds.length === 0 && !filter.channel) return null;
  return (
    <div
      aria-label="Filter conversations"
      className="flex min-w-0 flex-wrap items-center gap-1.5"
      role="group"
    >
      {props.kinds.map((kind) => {
        const active = filter.kind === kind.kind;
        return (
          <FilterChip
            active={active}
            dimmed={Boolean(filter.kind) && !active}
            key={kind.kind}
            label={`${kind.kind} (${kind.conversationCount})`}
            onClick={() =>
              props.onChange({
                ...filter,
                kind: active ? undefined : kind.kind,
              })
            }
          >
            <SpaceKindTag count={kind.conversationCount} kind={kind.kind} />
          </FilterChip>
        );
      })}
      {filter.channel ? (
        <FilterChip
          active
          dimmed={false}
          label={`Clear #${filter.channel} filter`}
          onClick={() => props.onChange({ ...filter, channel: undefined })}
        >
          <SpacePill className="border-cyan-300/40 text-cyan-100 hover:border-cyan-300/60">
            #{filter.channel}
            <X aria-hidden="true" className="size-3" />
          </SpacePill>
        </FilterChip>
      ) : null}
    </div>
  );
}

/** Compare channel names with and without a leading `#`. */
function channelKey(name: string | undefined): string | undefined {
  return name?.replace(/^#/, "") || undefined;
}

function SpaceList(props: {
  emptyText: string;
  spaces: SpaceSummary[];
  title: string;
}) {
  return (
    <Card as="section">
      <SectionTitle>{props.title}</SectionTitle>
      {props.spaces.length === 0 ? (
        <div className="p-4">
          <EmptyTelemetry>{props.emptyText}</EmptyTelemetry>
        </div>
      ) : (
        <ul className="m-0 list-none p-0">
          {props.spaces.map((space) => (
            <li
              className="border-b border-dashboard-border-subtle last:border-b-0"
              key={space.spaceId}
            >
              <Link
                className="flex min-w-0 items-center gap-4 px-4 py-3 text-inherit no-underline hover:bg-white/[0.03]"
                to={spacePath(space.spaceId)}
              >
                <FolderTree
                  aria-hidden
                  className="size-5 shrink-0 text-dashboard-text-muted"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-display text-base text-dashboard-text">
                    {space.name}
                  </div>
                </div>
                <div className="shrink-0 text-right font-mono text-xs text-dashboard-text-muted">
                  <div className="text-sm text-dashboard-text">
                    {formatCompactNumber(space.totalConversationCount)}{" "}
                    {space.totalConversationCount === 1
                      ? "conversation"
                      : "conversations"}
                  </div>
                  <div className="mt-1">
                    {space.childCount > 0
                      ? `${space.childCount} ${space.childCount === 1 ? "space" : "spaces"} · `
                      : ""}
                    {space.lastActivityAt
                      ? formatRelativeTime(space.lastActivityAt)
                      : "no activity"}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SpaceConversationList(props: {
  conversations: SpaceDetailReport["conversations"];
  filter: SpaceFilter;
  kinds: SpaceFacts["kinds"];
  onFilterChange(filter: SpaceFilter): void;
  privateCount: number;
}) {
  const filtered = Boolean(props.filter.kind || props.filter.channel);
  return (
    <section aria-label="Conversations" className="grid gap-2">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-1">
        <h3 className="m-0 font-display text-xs font-semibold uppercase tracking-[0.08em] text-dashboard-text-muted">
          Conversations
        </h3>
        <SpaceFilters
          filter={props.filter}
          kinds={props.kinds}
          onChange={props.onFilterChange}
        />
      </div>
      {props.conversations.length === 0 ? (
        <div className="rounded-lg border border-dashboard-border-subtle bg-dashboard-fill-faint p-4">
          <EmptyTelemetry>
            {filtered
              ? "No public Conversations match these filters."
              : "No public Conversations in this Space yet."}
          </EmptyTelemetry>
        </div>
      ) : (
        <div className="grid gap-2" role="list">
          {props.conversations.map((conversation) => (
            <SpaceConversationCard
              conversation={conversation}
              key={conversation.conversationId}
              onChannelClick={(channel) =>
                props.onFilterChange({ ...props.filter, channel })
              }
            />
          ))}
        </div>
      )}
      {props.privateCount > 0 ? (
        <div className="px-1 font-mono text-xs text-dashboard-text-muted">
          {props.privateCount} private{" "}
          {props.privateCount === 1 ? "conversation is" : "conversations are"}{" "}
          also in this Space.
        </div>
      ) : null}
    </section>
  );
}

/**
 * One Conversation in a Space, on one line: kind of work, title, channel,
 * people, and last activity. Clicking the channel filters the list by it.
 * Linked work stays on the Conversation page.
 */
function SpaceConversationCard(props: {
  conversation: SpaceDetailReport["conversations"][number];
  onChannelClick(channel: string): void;
}) {
  const report = props.conversation;
  const conversation = buildConversations([report])[0]!;
  const participants = conversationParticipants(conversation);
  const channel = channelKey(conversation.channelName);
  const location = slackLocationLabel(conversation, { includeId: false });
  return (
    <article
      className={cn(
        "group relative flex min-w-0 items-center gap-3 overflow-hidden rounded-lg border border-dashboard-border-subtle bg-dashboard-fill-faint px-4 py-2.5 transition-colors hover:border-dashboard-border hover:bg-dashboard-fill-soft md:px-5",
        report.kind &&
          "before:absolute before:inset-y-0 before:left-0 before:w-0.5",
        spaceKindAccentClass(report.kind),
      )}
      role="listitem"
    >
      <Link
        aria-label={`Open ${conversation.displayTitle}`}
        className="absolute inset-0 z-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-dashboard-focus"
        to={conversationPath(conversation.id)}
      />
      <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 items-center gap-2">
        {report.kind ? <SpaceKindTag kind={report.kind} /> : null}
        <h4 className="m-0 truncate font-display text-base font-medium leading-snug text-dashboard-text">
          {conversation.displayTitle}
        </h4>
      </div>
      <div className="pointer-events-none relative z-[1] flex shrink-0 items-center gap-2 font-mono text-xs text-dashboard-text-muted">
        {channel && location ? (
          <button
            aria-label={`Show only ${location}`}
            className="pointer-events-auto hidden cursor-pointer border-0 bg-transparent p-0 font-mono text-xs text-inherit hover:text-cyan-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus sm:inline"
            onClick={() => props.onChannelClick(channel)}
            type="button"
          >
            {location}
          </button>
        ) : null}
        {participants.length > 0 ? (
          <span className="pointer-events-auto inline-flex">
            <ParticipantAvatarStack participants={participants} size="list" />
          </span>
        ) : null}
        <span className="whitespace-nowrap">
          {formatRelativeTime(conversation.lastSeenAt)}
        </span>
      </div>
    </article>
  );
}
