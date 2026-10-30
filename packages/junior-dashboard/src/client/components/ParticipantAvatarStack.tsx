import type { ActorIdentity } from "@sentry/junior/api/schema";

import { actorLabel } from "../format";
import type { Conversation } from "../types";
import { ActorAvatar } from "./ActorAvatar";
import { Avatar, AvatarFallback } from "./ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const MAX_VISIBLE_PARTICIPANTS = 3;

type ParticipantAvatarStackProps = {
  participants: readonly ActorIdentity[];
  size: "detail" | "list";
};

function participantName(participant: ActorIdentity): string {
  return (
    participant.fullName?.trim() ||
    participant.slackUserName?.trim() ||
    participant.email?.trim() ||
    participant.slackUserId?.trim() ||
    "Unknown actor"
  );
}

function participantDescription(participant: ActorIdentity): string {
  const name = participantName(participant);
  const email = participant.email?.trim();
  return email && email !== name ? `${name}, ${email}` : name;
}

function participantKey(participant: ActorIdentity, index: number): string {
  return (
    participant.email?.trim().toLowerCase() ||
    participant.slackUserId?.trim() ||
    participant.slackUserName?.trim() ||
    `${actorLabel(participant) ?? "actor"}:${index}`
  );
}

function ParticipantTooltipContent(props: { participant: ActorIdentity }) {
  const name = participantName(props.participant);
  const email = props.participant.email?.trim();
  return (
    <span className="grid gap-0.5 font-sans">
      <span className="font-semibold text-dashboard-text">{name}</span>
      {email && email !== name ? (
        <span className="font-sans text-dashboard-text-muted">{email}</span>
      ) : null}
    </span>
  );
}

/** Show one actor avatar with their name and email on hover or focus. */
export function ParticipantAvatar(props: {
  participant: ActorIdentity;
  size: ParticipantAvatarStackProps["size"];
}) {
  const label = participantDescription(props.participant);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={label}
            // A name on a generic span is often skipped by screen readers.
            role="img"
            className="relative -ml-1 inline-flex rounded-full first:ml-0 pointer-events-none focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus [@media(hover:hover)_and_(pointer:fine)]:pointer-events-auto"
            onKeyDown={(event) => event.stopPropagation()}
            tabIndex={0}
          >
            <ActorAvatar
              name={participantName(props.participant)}
              size={props.size}
            />
          </span>
        }
      />
      <TooltipContent>
        <ParticipantTooltipContent participant={props.participant} />
      </TooltipContent>
    </Tooltip>
  );
}

/** Use projected participants, with the root actor as a legacy fallback. */
export function conversationParticipants(
  conversation: Conversation | undefined,
): readonly ActorIdentity[] {
  if (conversation?.participants?.length) return conversation.participants;
  return conversation?.actorIdentity ? [conversation.actorIdentity] : [];
}

/** Show Conversation actors in first-appearance order. */
export function ParticipantAvatarStack(props: ParticipantAvatarStackProps) {
  if (props.participants.length === 0) return null;
  const visible = props.participants.slice(0, MAX_VISIBLE_PARTICIPANTS);
  const hidden = props.participants.slice(MAX_VISIBLE_PARTICIPANTS);
  const label = props.participants.map(participantDescription).join("; ");
  return (
    <span
      aria-label={`Conversation participants: ${label}`}
      className="inline-flex items-center"
      role="group"
    >
      {visible.map((participant, index) => (
        <ParticipantAvatar
          key={participantKey(participant, index)}
          participant={participant}
          size={props.size}
        />
      ))}
      {hidden.length > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Avatar
                aria-label={`${hidden.length} more participants: ${hidden
                  .map(participantDescription)
                  .join("; ")}`}
                className="-ml-1 pointer-events-none bg-dashboard-surface-active shadow-none focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus [@media(hover:hover)_and_(pointer:fine)]:pointer-events-auto"
                onKeyDown={(event) => event.stopPropagation()}
                size={props.size === "list" ? "sm" : "default"}
                tabIndex={0}
              >
                <AvatarFallback className="tabular-nums tracking-normal text-dashboard-text-muted">
                  +{hidden.length}
                </AvatarFallback>
              </Avatar>
            }
          />
          <TooltipContent>
            <span className="grid gap-1 font-sans">
              {hidden.map((participant, index) => (
                <span key={participantKey(participant, index)}>
                  {participantDescription(participant)}
                </span>
              ))}
            </span>
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  );
}
