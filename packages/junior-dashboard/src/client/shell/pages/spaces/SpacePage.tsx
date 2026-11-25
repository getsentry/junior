import { useState } from "react";
import { Ellipsis } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import type { SpaceReport } from "@sentry/junior/api/schema";

import { getDashboardAgentName } from "../../../agentName";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { EmptyTelemetry } from "../../../components/EmptyTelemetry";
import { PageContentSkeleton } from "../../../components/PageContentSkeleton";
import { PageFrame } from "../../../components/layout/PageFrame";
import { SectionTitle } from "../../../components/layout/SectionTitle";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";
import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu";
import { ConversationComposer } from "../../../conversations/ConversationComposer";
import { prefetchConversationDetail } from "../../../conversations/conversationPrefetch";
import {
  conversationPath,
  FOCUS_REPLY_STATE,
} from "../../../conversations/conversationRoutes";
import { newestFirst } from "../../../conversations/conversationSections";
import { useCreateConversation } from "../../../conversations/queries";
import { buildConversations } from "../../../format";
import { DashboardApiError } from "../../../http";
import { useWaitingConversations } from "../../../inbox/queries";
import {
  useArchiveSpace,
  useSpaceConversationsData,
  useSpaceData,
  useSpaceMembersData,
  useSpaceMembership,
} from "../../../spaces/queries";
import { SpaceTile } from "../../../spaces/SpaceTile";
import { cn, dashboardCountClass } from "../../../styles";
import { fadeOverflowClass, fadeWhenOverflowing } from "../../../textFade";
import { getDashboardTimeZone } from "../../../time";
import { ConversationHomeList } from "../../conversations/ConversationHomeList";

/**
 * One Space: what it is for, a composer that starts work in it, its
 * Conversations, and its members. Anyone can open a Space and join it.
 */
export function SpacePage() {
  const { spaceId } = useParams();
  const query = useSpaceData(spaceId);
  const space = query.data;
  const name = space?.name ?? "Space";
  return (
    <PageFrame
      actions={space ? <SpaceActions space={space} /> : undefined}
      icon={space ? <SpaceTile size="md" space={space} /> : undefined}
      phoneTitle={name}
      title={name}
    >
      {space ? (
        <SpaceBody space={space} />
      ) : query.error ? (
        <EmptyTelemetry>This Space is unavailable.</EmptyTelemetry>
      ) : (
        <PageContentSkeleton label="Loading Space" variant="list" />
      )}
    </PageFrame>
  );
}

/** Join for a non-member. A member's menu leaves, archives, or restores. */
function SpaceActions(props: { space: SpaceReport }) {
  const { space } = props;
  const membership = useSpaceMembership(space.id);
  const archive = useArchiveSpace(space.id);
  const [confirmArchive, setConfirmArchive] = useState(false);
  if (!space.viewerIsMember) {
    return (
      <Button
        disabled={membership.isPending}
        onClick={() => membership.mutate(true)}
        variant="default"
      >
        Join
      </Button>
    );
  }
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          render={
            <Button aria-label="Space menu" size="icon" variant="ghost">
              <Ellipsis aria-hidden="true" size={18} />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem
            disabled={archive.isPending}
            onClick={() =>
              space.archivedAt ? archive.mutate(false) : setConfirmArchive(true)
            }
          >
            {space.archivedAt ? "Restore Space" : "Archive Space"}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={membership.isPending}
            onClick={() => membership.mutate(false)}
          >
            Leave Space
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {confirmArchive ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirmArchive(false);
          }}
        >
          <AlertDialogContent>
            <AlertDialogTitle>Archive {space.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops and archives every conversation in the Space, for
              everyone.
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirmArchive(false);
                  archive.mutate(true);
                }}
              >
                Archive
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </>
  );
}

function SpaceBody(props: { space: SpaceReport }) {
  const { space } = props;
  const feed = useSpaceConversationsData(space.id);
  const waitingConversations = useWaitingConversations();
  const conversations = newestFirst(
    buildConversations(feed.data?.conversations ?? []),
  );
  return (
    <>
      {space.description ? (
        <p className="m-0 max-w-3xl font-sans text-sm leading-relaxed text-dashboard-text-muted">
          {space.description}
        </p>
      ) : null}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="grid min-w-0 gap-6">
          {space.archivedAt ? (
            <p className="m-0 font-sans text-sm text-dashboard-text-muted">
              This Space is archived. Restore it to start new work.
            </p>
          ) : space.viewerIsMember ? (
            <SpaceComposer space={space} />
          ) : (
            <p className="m-0 font-sans text-sm text-dashboard-text-muted">
              Join this Space to start a conversation in it.
            </p>
          )}
          <section aria-label="Conversations" className="grid gap-3">
            <SectionTitle>Conversations</SectionTitle>
            {feed.error ? (
              <EmptyTelemetry>
                Conversations are unavailable. Try refreshing the dashboard.
              </EmptyTelemetry>
            ) : (
              <ConversationHomeList
                conversations={conversations}
                emptyLabel="No conversations in this Space yet."
                loading={!feed.data}
                timeZone={getDashboardTimeZone()}
                waitingConversations={waitingConversations}
              />
            )}
          </section>
        </div>
        <SpaceMembers space={space} />
      </div>
    </>
  );
}

/** Start a Conversation in the Space, then open it. */
function SpaceComposer(props: { space: SpaceReport }) {
  const { space } = props;
  const create = useCreateConversation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (
    <ConversationComposer
      draftId={`space:${space.id}`}
      error={
        create.error
          ? (create.error instanceof DashboardApiError &&
              create.error.apiError) ||
            "Message failed to send. Try again."
          : undefined
      }
      holdDraftUntilAccept
      label={`Start a conversation in ${space.name}`}
      onSubmit={async (message, idempotencyKey, files) => {
        const accepted = await create.mutateAsync({
          files,
          idempotencyKey,
          message,
          spaceId: space.id,
        });
        // The page then opens with its transcript, not a skeleton.
        await prefetchConversationDetail(queryClient, accepted.conversationId);
        await navigate(conversationPath(accepted.conversationId), {
          state: FOCUS_REPLY_STATE,
        });
      }}
      placeholder={`Message ${getDashboardAgentName()}…`}
      submitLabel="Send"
    />
  );
}

function SpaceMembers(props: { space: SpaceReport }) {
  const members = useSpaceMembersData(props.space.id);
  return (
    <section aria-label="Members" className="grid gap-3">
      <SectionTitle>
        Members{" "}
        <span className={cn(dashboardCountClass, "font-normal")}>
          {props.space.memberCount}
        </span>
      </SectionTitle>
      {members.data ? (
        <ul className="m-0 grid gap-2 p-0">
          {members.data.members.map((member) => {
            const name = member.displayName ?? member.email;
            return (
              <li
                className="flex min-w-0 list-none items-center gap-2 font-sans text-sm text-dashboard-text"
                key={member.userId}
              >
                <ActorAvatar
                  imageUrl={member.avatarUrl ?? undefined}
                  name={name}
                  size="list"
                />
                <span className={fadeOverflowClass} ref={fadeWhenOverflowing}>
                  {name}
                </span>
              </li>
            );
          })}
        </ul>
      ) : members.error ? (
        <p className="m-0 font-sans text-sm text-dashboard-text-muted">
          Members are unavailable.
        </p>
      ) : (
        <div aria-busy="true" className="grid gap-2" role="status">
          <span className="sr-only">Loading members</span>
          {[0, 1].map((row) => (
            <div
              aria-hidden="true"
              className="flex items-center gap-2"
              key={row}
            >
              <Skeleton className="size-6 rounded-full" />
              <Skeleton className="h-4 w-28" />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
