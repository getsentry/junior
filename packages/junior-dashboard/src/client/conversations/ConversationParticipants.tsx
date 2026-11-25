import { lazy, Suspense, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  conversationInviteResponseSchema,
  type ActorIdentity,
  type ConversationDetailReport,
  type UserSearchResult,
} from "@sentry/junior/api/schema";

import { ParticipantAvatarStack } from "../components/ParticipantAvatarStack";
import { Button } from "../components/ui/button";
import { post } from "../http";
import { DetailsCard } from "./DetailsList";
import { conversationDetailQueryKey } from "./queries";

// The picker opens only after a click, so it loads with the first open
// instead of with every Conversation page.
const PeoplePicker = lazy(() =>
  import("../components/PeoplePicker").then((module) => ({
    default: module.PeoplePicker,
  })),
);

/**
 * Invite subscribes a person to a public Conversation and grants no
 * access, so a private one has none. An archived one is in no feed. A
 * Task has no people of its own. The API checks again.
 */
function canInvite(detail: ConversationDetailReport | undefined): boolean {
  return (
    detail?.visibility === "public" &&
    detail.kind !== "task" &&
    !detail.archivedAt
  );
}

/**
 * The Participants of a Conversation, and Invite where the viewer may add
 * people to it.
 */
export function ConversationParticipants(props: {
  conversationId: string;
  detail: ConversationDetailReport | undefined;
  participants: readonly ActorIdentity[];
}) {
  const [inviting, setInviting] = useState(false);
  const invitable = canInvite(props.detail);
  const queryClient = useQueryClient();
  if (props.participants.length === 0 && !invitable) return null;
  const invite = async (user: UserSearchResult) => {
    await post(
      conversationInviteResponseSchema,
      `/api/conversations/${encodeURIComponent(props.conversationId)}/invites`,
      { slackUserId: user.slackUserId },
    );
  };
  return (
    <DetailsCard
      action={
        invitable ? (
          <Button
            aria-expanded={inviting}
            className="rounded-md px-1.5 py-0.5 text-xs"
            onClick={() => setInviting((value) => !value)}
            size="bare"
            variant="ghost"
          >
            {inviting ? "Cancel" : "Invite"}
          </Button>
        ) : null
      }
      label="Participants"
      title="Participants"
    >
      {inviting ? (
        <Suspense fallback={null}>
          <PeoplePicker
            add={invite}
            label="Invite people"
            memberLabel="Participant"
            onCancel={() => setInviting(false)}
            onDone={() => {
              setInviting(false);
              void queryClient.invalidateQueries({
                queryKey: conversationDetailQueryKey(props.conversationId),
              });
            }}
            submitLabel="Invite"
            target={{ conversationId: props.conversationId }}
          />
        </Suspense>
      ) : null}
      {props.participants.length > 0 ? (
        <ParticipantAvatarStack
          participants={props.participants}
          size="detail"
        />
      ) : null}
    </DetailsCard>
  );
}
