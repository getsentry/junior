import { createContext, useContext, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  conversationInviteResponseSchema,
  type MentionablePerson,
} from "@sentry/junior/api/schema";
import { ActorAvatar } from "../components/ActorAvatar";
import { Button, buttonVariants } from "../components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "../components/ui/popover";
import { peoplePath } from "../format";
import { post } from "../http";
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
 * A person mentioned in the composer: their photo and name, with a card that
 * links their profile and can Invite them. A person whose name the composer
 * does not know shows their Slack id.
 */
export function ComposerMention(props: {
  person: Partial<MentionablePerson> & { slackUserId: string };
}) {
  const { person } = props;
  const name = mentionName(person);
  return (
    <Popover>
      <PopoverTrigger
        className="cursor-pointer rounded-sm font-medium whitespace-nowrap text-dashboard-accent-text hover:bg-dashboard-accent/15"
        data-mention={person.slackUserId}
        nativeButton={false}
        render={<span role="button" tabIndex={-1} />}
      >
        {person.avatarUrl ? <MentionPhoto src={person.avatarUrl} /> : null}@
        {name}
      </PopoverTrigger>
      {/* The shared person card replaces this content when it lands, with
          InviteAction in its actions slot. */}
      <PopoverContent align="start" className="w-64" side="top">
        <div className="flex items-center gap-3">
          <ActorAvatar imageUrl={person.avatarUrl} name={name} size="detail" />
          <PopoverTitle className="min-w-0 truncate">{name}</PopoverTitle>
        </div>
        <div className="mt-3 flex items-center justify-end gap-2 text-xs">
          {person.email ? (
            <Link
              className={buttonVariants({ variant: "ghost" })}
              to={peoplePath(person.email)}
            >
              Profile
            </Link>
          ) : null}
          {person.email ? (
            <InviteAction slackUserId={person.slackUserId} />
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
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
function InviteAction(props: { slackUserId: string }) {
  const target = useContext(ComposerInviteContext);
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
  if (!target) return null;
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
