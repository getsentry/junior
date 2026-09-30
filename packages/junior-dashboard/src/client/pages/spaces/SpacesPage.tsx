import type {
  SpaceConversation,
  SpaceSummary,
} from "@sentry/junior/api/schema";
import { ChevronRight, FolderTree, MessagesSquare } from "lucide-react";
import { Link, useParams } from "react-router";
import { useSpaceDetailData, useSpaceTreeData } from "../../api";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { PageRouteLoading } from "../../components/PageRouteLoading";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { conversationPath } from "../../conversations/conversationRoutes";
import { formatCompactNumber, formatRelativeTime } from "../../format";

const DESCRIPTION =
  "Nested forum categories. Junior files each Conversation into one Space.";

/** Dashboard path for one Space. */
export function spacePath(spaceId: string): string {
  return `/spaces/${encodeURIComponent(spaceId)}`;
}

/** Render the Spaces forum: the landing list or one Space. */
export function SpacesPage() {
  const { spaceId } = useParams();
  return spaceId ? <SpaceDetail spaceId={spaceId} /> : <SpaceLanding />;
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
        description={data.space.description || "No description yet."}
        title={data.space.name}
      />
      {data.children.length > 0 ? (
        <SpaceList emptyText="" spaces={data.children} title="Spaces" />
      ) : null}
      <ConversationList
        conversations={data.conversations}
        privateCount={data.privateConversationCount}
      />
    </PageLayout>
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
                    <div className="mt-1 line-clamp-2 text-sm text-dashboard-text-muted">
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

function ConversationList(props: {
  conversations: SpaceConversation[];
  privateCount: number;
}) {
  return (
    <Card as="section">
      <SectionTitle>Conversations</SectionTitle>
      {props.conversations.length === 0 ? (
        <div className="p-4">
          <EmptyTelemetry>
            No public Conversations in this Space yet.
          </EmptyTelemetry>
        </div>
      ) : (
        <ul className="m-0 list-none p-0">
          {props.conversations.map((conversation) => (
            <li
              className="border-b border-dashboard-border-subtle last:border-b-0"
              key={conversation.conversationId}
            >
              <Link
                className="flex min-w-0 items-start gap-4 px-4 py-3 text-inherit no-underline hover:bg-white/[0.03]"
                to={conversationPath(conversation.conversationId)}
              >
                <MessagesSquare
                  aria-hidden
                  className="mt-0.5 size-5 shrink-0 text-dashboard-text-muted"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-display text-base text-dashboard-text">
                    {conversation.title ?? "Untitled conversation"}
                  </div>
                  {conversation.summary ? (
                    <div className="mt-1 line-clamp-2 text-sm text-dashboard-text-muted">
                      {conversation.summary}
                    </div>
                  ) : null}
                </div>
                <div className="shrink-0 text-right font-mono text-xs text-dashboard-text-muted">
                  {conversation.channelName ? (
                    <div>#{conversation.channelName}</div>
                  ) : null}
                  <div className="mt-1">
                    {formatRelativeTime(conversation.lastActivityAt)}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {props.privateCount > 0 ? (
        <div className="border-t border-dashboard-border-subtle px-4 py-3 font-mono text-xs text-dashboard-text-muted">
          {props.privateCount} private{" "}
          {props.privateCount === 1 ? "conversation is" : "conversations are"}{" "}
          also in this Space.
        </div>
      ) : null}
    </Card>
  );
}
