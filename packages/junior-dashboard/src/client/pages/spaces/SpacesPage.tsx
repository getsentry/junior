import type {
  ConversationKindReport,
  ConversationSummaryReport,
  SpaceDetailReport,
  SpaceFacts,
  SpaceSummary,
} from "@sentry/junior/api/schema";
import {
  ChevronRight,
  FolderTree,
  GitBranch,
  Hash,
  MessageSquarePlus,
} from "lucide-react";
import { useState } from "react";
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
import { ConversationAnnotations } from "../../conversations/ConversationMeta";
import { NewConversationView } from "../../conversations/NewConversationView";
import { conversationPath } from "../../conversations/conversationRoutes";
import { useCreateConversation } from "../../conversations/queries";
import {
  buildConversations,
  formatCompactNumber,
  formatRelativeTime,
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
  const [kindFilter, setKindFilter] = useState<ConversationKindReport>();
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
        description={<SpaceKeywords description={data.space.description} />}
        title={data.space.name}
      />
      {composing ? (
        <SpaceComposer
          spaceId={data.space.spaceId}
          spaceName={data.space.name}
        />
      ) : null}
      <SpaceFactsCard
        facts={data.facts}
        kindFilter={kindFilter}
        linkedWork={spaceLinkedWork(data.conversations)}
        onKindFilter={setKindFilter}
      />
      {data.children.length > 0 ? (
        <SpaceList emptyText="" spaces={data.children} title="Spaces" />
      ) : null}
      <SpaceConversationList
        conversations={
          kindFilter
            ? data.conversations.filter(
                (conversation) => conversation.kind === kindFilter,
              )
            : data.conversations
        }
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

/** Show a Space description as keyword pills when it is a keyword list. */
function SpaceKeywords(props: { description: string }) {
  const keywords = props.description
    .split(",")
    .map((keyword) => keyword.trim())
    .filter(Boolean);
  if (keywords.length < 2) {
    return <>{props.description || "No description yet."}</>;
  }
  return (
    <span className="flex flex-wrap gap-1.5">
      {keywords.map((keyword) => (
        <SpacePill key={keyword}>{keyword}</SpacePill>
      ))}
    </span>
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

function FactRow(props: { children: React.ReactNode; label: string }) {
  return (
    <div className="grid min-w-0 gap-2 sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-start">
      <div className="pt-0.5 font-mono text-xs uppercase tracking-[0.08em] text-dashboard-text-muted">
        {props.label}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {props.children}
      </div>
    </div>
  );
}

const MAX_LINKED_WORK = 8;

/**
 * Collect the linked work of a Space, newest Conversation first, so pull
 * requests and issues show the same way as on the conversation page.
 */
function spaceLinkedWork(
  conversations: SpaceDetailReport["conversations"],
): Pick<ConversationSummaryReport, "annotations" | "sidebarAnnotations"> {
  const seen = new Set<string>();
  const annotations: NonNullable<ConversationSummaryReport["annotations"]> = [];
  const sidebarAnnotations: NonNullable<
    ConversationSummaryReport["sidebarAnnotations"]
  > = [];
  for (const conversation of conversations) {
    for (const annotation of conversation.annotations ?? []) {
      const key = `${annotation.plugin}:${annotation.key}`;
      if (!annotation.url || seen.has(key)) continue;
      if (annotations.length >= MAX_LINKED_WORK) break;
      seen.add(key);
      annotations.push(annotation);
    }
    sidebarAnnotations.push(...(conversation.sidebarAnnotations ?? []));
  }
  return { annotations, sidebarAnnotations };
}

/** Hard facts about the Space: repositories, work, channels, and people. */
function SpaceFactsCard(props: {
  facts: SpaceFacts;
  kindFilter: ConversationKindReport | undefined;
  linkedWork: Pick<
    ConversationSummaryReport,
    "annotations" | "sidebarAnnotations"
  >;
  onKindFilter: (kind: ConversationKindReport | undefined) => void;
}) {
  const { facts } = props;
  const hasLinkedWork = Boolean(props.linkedWork.annotations?.length);
  const empty =
    facts.repositories.length === 0 &&
    !hasLinkedWork &&
    facts.channels.length === 0 &&
    facts.participants.length === 0 &&
    facts.kinds.length === 0;
  if (empty) return null;
  return (
    <Card as="section">
      <SectionTitle>Facts</SectionTitle>
      <div className="grid gap-4 p-4">
        {facts.repositories.length > 0 ? (
          <FactRow label="Repositories">
            {facts.repositories.map((repository) => (
              <a
                className="no-underline"
                href={repository.url}
                key={repository.name}
                rel="noopener noreferrer"
                target="_blank"
              >
                <SpacePill className="text-dashboard-text hover:border-white/25">
                  <GitBranch aria-hidden="true" className="size-3" />
                  {repository.name}
                  <span className="font-mono opacity-60">
                    {repository.conversationCount}
                  </span>
                </SpacePill>
              </a>
            ))}
          </FactRow>
        ) : null}
        {facts.kinds.length > 0 ? (
          <FactRow label="Kinds">
            {facts.kinds.map((kind) => {
              const active = props.kindFilter === kind.kind;
              return (
                <button
                  aria-pressed={active}
                  className={cn(
                    "cursor-pointer rounded-full border-0 bg-transparent p-0 transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus",
                    props.kindFilter && !active && "opacity-40",
                  )}
                  key={kind.kind}
                  onClick={() =>
                    props.onKindFilter(active ? undefined : kind.kind)
                  }
                  title={
                    active ? "Show all conversations" : "Show only this kind"
                  }
                  type="button"
                >
                  <SpaceKindTag
                    count={kind.conversationCount}
                    kind={kind.kind}
                  />
                </button>
              );
            })}
          </FactRow>
        ) : null}
        {facts.channels.length > 0 ? (
          <FactRow label="Channels">
            {facts.channels.map((channel) => (
              <SpacePill key={channel.name}>
                <Hash aria-hidden="true" className="size-3" />
                {channel.name}
                <span className="font-mono opacity-60">
                  {channel.conversationCount}
                </span>
              </SpacePill>
            ))}
          </FactRow>
        ) : null}
        {facts.participants.length > 0 ? (
          <FactRow label="People">
            <ParticipantAvatarStack
              participants={facts.participants}
              size="detail"
            />
            <span className="font-mono text-xs text-dashboard-text-muted">
              {facts.participants.length}{" "}
              {facts.participants.length === 1 ? "person" : "people"}
            </span>
          </FactRow>
        ) : null}
        {hasLinkedWork ? (
          <FactRow label="Linked work">
            <ConversationAnnotations detail={props.linkedWork} />
          </FactRow>
        ) : null}
      </div>
    </Card>
  );
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
                  {space.description ? (
                    <div className="mt-1 line-clamp-1 text-sm text-dashboard-text-muted">
                      {space.description}
                    </div>
                  ) : null}
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
  privateCount: number;
}) {
  return (
    <section aria-label="Conversations" className="grid gap-2">
      <h3 className="m-0 px-1 font-display text-xs font-semibold uppercase tracking-[0.08em] text-dashboard-text-muted">
        Conversations
      </h3>
      {props.conversations.length === 0 ? (
        <div className="rounded-lg border border-dashboard-border-subtle bg-dashboard-fill-faint p-4">
          <EmptyTelemetry>
            No public Conversations in this Space yet.
          </EmptyTelemetry>
        </div>
      ) : (
        <div className="grid gap-2" role="list">
          {props.conversations.map((conversation) => (
            <SpaceConversationCard
              conversation={conversation}
              key={conversation.conversationId}
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
 * One Conversation in a Space. It follows the home page card: title, Brief
 * summary, channel, people, and linked work, plus a kind-of-work tag.
 */
function SpaceConversationCard(props: {
  conversation: SpaceDetailReport["conversations"][number];
}) {
  const report = props.conversation;
  const conversation = buildConversations([report])[0]!;
  const participants = conversationParticipants(conversation);
  const channel = conversation.channelName;
  return (
    <article
      className={cn(
        "group relative grid min-w-0 gap-2 overflow-hidden rounded-lg border border-dashboard-border-subtle bg-dashboard-fill-faint px-4 py-3.5 transition-colors hover:border-dashboard-border hover:bg-dashboard-fill-soft md:px-5",
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
      <div className="pointer-events-none relative z-[1] grid min-w-0 grid-cols-[minmax(0,1fr)_max-content] items-start gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {report.kind ? <SpaceKindTag kind={report.kind} /> : null}
          <h4 className="m-0 truncate font-display text-base font-medium leading-snug text-dashboard-text">
            {conversation.displayTitle}
          </h4>
        </div>
        <span className="whitespace-nowrap font-mono text-xs text-dashboard-text-muted">
          {formatRelativeTime(conversation.lastSeenAt)}
        </span>
      </div>
      {report.summary ? (
        <p className="pointer-events-none relative z-[1] m-0 line-clamp-2 font-sans text-sm leading-relaxed text-dashboard-text-subtle">
          {report.summary}
        </p>
      ) : null}
      <div className="pointer-events-none relative z-[1] flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-xs text-dashboard-text-muted">
        {channel ? (
          <SpacePill>
            <Hash aria-hidden="true" className="size-3" />
            {channel}
          </SpacePill>
        ) : null}
        {participants.length > 0 ? (
          <span className="pointer-events-auto inline-flex">
            <ParticipantAvatarStack participants={participants} size="list" />
          </span>
        ) : null}
        {participants.length > 1 ? (
          <span>{participants.length} people</span>
        ) : null}
      </div>
      {report.annotations?.some((annotation) => annotation.url) ? (
        <div className="relative z-[1] -mx-1 min-w-0">
          <ConversationAnnotations detail={report} layout="strip" />
        </div>
      ) : null}
    </article>
  );
}
