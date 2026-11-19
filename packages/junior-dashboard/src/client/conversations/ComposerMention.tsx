import { createContext, useContext, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  conversationInviteResponseSchema,
  type MentionablePerson,
} from "@sentry/junior/api/schema";
import { PersonCard } from "../components/PersonCard";
import { Button } from "../components/ui/button";
import { HoverPreview } from "../components/ui/hover-preview";
import { post } from "../http";
import { personFromActor } from "../person";
import { mentionName } from "./composerMentionToken";
import { conversationDetailQueryKey } from "./queries";

/**
 * The public Conversation that a mention card can Invite people to, and the
 * Slack ids of its Participants. Without it the card has no Invite.
 */
export type ComposerInviteTarget = {
  conversationId: string;
  participantSlackUserIds: ReadonlySet<string>;
};

/** Give the mention cards of one composer their Invite target. */
export const ComposerInviteContext = createContext<
  ComposerInviteTarget | undefined
>(undefined);

/**
 * A person mentioned in the composer: their photo and name. Hover, focus,
 * or a tap shows their person card, which can Invite them. A person whose
 * name the composer does not know shows their Slack id and no card.
 */
export function ComposerMention(props: {
  person: Partial<MentionablePerson> & { slackUserId: string };
}) {
  const { person } = props;
  const target = useContext(ComposerInviteContext);
  const card = person.email ? personFromActor(person) : undefined;
  const chip = (
    <>
      {person.avatarUrl ? <MentionPhoto src={person.avatarUrl} /> : null}@
      {mentionName(person)}
    </>
  );
  const chipProps = {
    className:
      "cursor-pointer rounded-sm font-medium whitespace-nowrap text-dashboard-accent-text hover:bg-dashboard-accent/15",
    "data-mention": person.slackUserId,
  };
  if (!card) return <span {...chipProps}>{chip}</span>;
  return (
    <HoverPreview
      content={
        <PersonCard
          actions={
            target ? (
              <InviteAction slackUserId={person.slackUserId} target={target} />
            ) : undefined
          }
          person={card}
        />
      }
      tapToOpen
      trigger={<span {...chipProps} role="button" tabIndex={-1} />}
    >
      {chip}
    </HoverPreview>
  );
}

// Like a transcript mention: a photo at text height. A photo that fails to
// load does not render.
function MentionPhoto(props: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      alt=""
      className="mr-1 inline-block size-[1em] rounded-full object-cover align-[-0.125em]"
      onError={() => setFailed(true)}
      src={props.src}
    />
  );
}

/**
 * Subscribe the person to the public Conversation, as the `Attach` action
 * of an object card adds the object. The API checks again that the
 * Conversation is public and that the viewer can act on it.
 */
function InviteAction(props: {
  slackUserId: string;
  target: ComposerInviteTarget;
}) {
  const { target } = props;
  const queryClient = useQueryClient();
  const invite = useMutation({
    mutationFn: (conversationId: string) =>
      post(
        conversationInviteResponseSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/invites`,
        { slackUserId: props.slackUserId },
      ),
    onSuccess: (_result, conversationId) =>
      queryClient.invalidateQueries({
        queryKey: conversationDetailQueryKey(conversationId),
      }),
  });
  if (
    target.participantSlackUserIds.has(props.slackUserId) ||
    invite.isSuccess
  ) {
    return <span className="text-dashboard-text-muted">Subscribed</span>;
  }
  return (
    <>
      {invite.isError ? (
        <span className="text-dashboard-text-muted">Could not invite.</span>
      ) : null}
      <Button
        disabled={invite.isPending}
        onClick={() => invite.mutate(target.conversationId)}
        type="button"
        variant="outline"
      >
        Invite
      </Button>
    </>
  );
}
