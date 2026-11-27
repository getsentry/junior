import { Plus, X } from "lucide-react";
import { lazy, Suspense, useState, type ReactNode } from "react";
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
import { conversationDetailQueryKey } from "./queries";

// The picker opens only after a click, so it loads with the first open
// instead of with every Conversation page.
const PeoplePicker = lazy(() =>
  import("../components/PeoplePicker").then((module) => ({
    default: module.PeoplePicker,
  })),
);

/**
 * The API says who may Invite. An archived Conversation is in no feed. A
 * Task has no people of its own. The API checks again.
 */
function canInvite(detail: ConversationDetailReport | undefined): boolean {
  return (
    detail?.canInvite === true && detail.kind !== "task" && !detail.archivedAt
  );
}

/**
 * Close Conversation details with one row: the Participants and Invite on
 * the left, and `trailing`, such as cost and Usage, on the right. Invite
 * opens the people picker above the row.
 */
export function ConversationParticipants(props: {
  conversationId: string;
  detail: ConversationDetailReport | undefined;
  participants: readonly ActorIdentity[];
  trailing?: ReactNode;
}) {
  const [inviting, setInviting] = useState(false);
  const invitable = canInvite(props.detail);
  const queryClient = useQueryClient();
  const invite = async (user: UserSearchResult) => {
    await post(
      conversationInviteResponseSchema,
      `/api/conversations/${encodeURIComponent(props.conversationId)}/invites`,
      { userId: user.userId },
    );
  };
  return (
    <section aria-label="Participants" className="grid min-w-0 gap-3">
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
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          {props.participants.length > 0 ? (
            <ParticipantAvatarStack
              participants={props.participants}
              size="detail"
            />
          ) : null}
          {invitable ? (
            <Button
              aria-expanded={inviting}
              aria-label={inviting ? "Cancel invite" : "Invite"}
              className="size-6 rounded-full text-dashboard-text-muted hover:text-dashboard-text"
              onClick={() => setInviting((value) => !value)}
              size="bare"
              title={inviting ? "Cancel invite" : "Invite"}
              variant="ghost"
            >
              {inviting ? (
                <X aria-hidden="true" size={14} />
              ) : (
                <Plus aria-hidden="true" size={14} />
              )}
            </Button>
          ) : null}
        </div>
        {props.trailing}
      </div>
    </section>
  );
}
