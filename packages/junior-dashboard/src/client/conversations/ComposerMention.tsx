import { createContext, useContext, useState } from "react";
import {
  useMutation,
  useMutationState,
  useQueryClient,
} from "@tanstack/react-query";

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
 * The Conversation that a composer writes to. The `@` menu finds people of
 * its Slack workspace. `invite` is true when a mention card can Invite
 * people to it: it is public and not archived.
 */
export type ComposerConversation = {
  conversationId: string;
  invite: boolean;
};

/** Give the `@` menu and mention cards of one composer their Conversation. */
export const ComposerConversationContext = createContext<
  ComposerConversation | undefined
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
  const conversation = useContext(ComposerConversationContext);
  const card = personFromActor(person);
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
            // Only a User has a feed to Invite them to.
            conversation?.invite && person.hasUser ? (
              <InviteAction
                conversation={conversation}
                slackUserId={person.slackUserId}
              />
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
  conversation: ComposerConversation;
  slackUserId: string;
}) {
  const { conversation } = props;
  const queryClient = useQueryClient();
  const mutationKey = [
    "conversation-invite",
    conversation.conversationId,
    props.slackUserId,
  ];
  const invite = useMutation({
    // The card unmounts when it closes. A kept result lets a reopened card
    // show the answer for this person and Conversation.
    gcTime: Infinity,
    mutationKey,
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
  const answer = useMutationState({
    filters: { exact: true, mutationKey, status: "success" },
    select: (mutation) =>
      conversationInviteResponseSchema.safeParse(mutation.state.data).data,
  }).at(-1);
  // Only the API knows who is subscribed, so the card shows its answer.
  if (answer) {
    return (
      <span className="text-dashboard-text-muted">
        {answer.added ? "Subscribed" : "Already a participant"}
      </span>
    );
  }
  return (
    <>
      {invite.isError ? (
        <span className="text-dashboard-text-muted">Could not invite.</span>
      ) : null}
      <Button
        disabled={invite.isPending}
        onClick={() => invite.mutate(conversation.conversationId)}
        type="button"
        variant="outline"
      >
        Invite
      </Button>
    </>
  );
}
