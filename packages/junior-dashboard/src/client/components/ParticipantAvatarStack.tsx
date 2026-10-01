import type { ActorIdentity } from "@sentry/junior/api/schema";

import { actorLabel } from "../format";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { ActorAvatar } from "./ActorAvatar";
import { Tooltip } from "./Tooltip";

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
        <span className="font-mono text-dashboard-text-muted">{email}</span>
      ) : null}
    </span>
  );
}

function Avatar(props: {
  participant: ActorIdentity;
  size: ParticipantAvatarStackProps["size"];
}) {
  const label = participantDescription(props.participant);
  return (
    <Tooltip
      content={<ParticipantTooltipContent participant={props.participant} />}
      focusable
      triggerClassName="-ml-1.5 first:ml-0 pointer-events-none [@media(hover:hover)_and_(pointer:fine)]:pointer-events-auto"
    >
      <span
        aria-label={label}
        className="relative inline-flex rounded-full focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus"
        onKeyDown={(event) => event.stopPropagation()}
        tabIndex={0}
      >
        <ActorAvatar
          name={participantName(props.participant)}
          size={props.size}
        />
      </span>
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
        <Avatar
          key={participantKey(participant, index)}
          participant={participant}
          size={props.size}
        />
      ))}
      {hidden.length > 0 ? (
        <Tooltip
          content={
            <span className="grid gap-1 font-sans">
              {hidden.map((participant, index) => (
                <span key={participantKey(participant, index)}>
                  {participantDescription(participant)}
                </span>
              ))}
            </span>
          }
          focusable
          triggerClassName="-ml-1.5 pointer-events-none [@media(hover:hover)_and_(pointer:fine)]:pointer-events-auto"
        >
          <span
            aria-label={`${hidden.length} more participants: ${hidden
              .map(participantDescription)
              .join("; ")}`}
            className={cn(
              "relative inline-grid shrink-0 place-items-center rounded-full border-2 border-dashboard-bg bg-dashboard-fill-strong font-mono font-semibold leading-none text-dashboard-text-muted focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus",
              props.size === "list" ? "size-6 text-2xs" : "size-7 text-xs",
            )}
            onKeyDown={(event) => event.stopPropagation()}
            tabIndex={0}
          >
            +{hidden.length}
          </span>
        </Tooltip>
      ) : null}
    </span>
  );
}
