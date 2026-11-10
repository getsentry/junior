import type { ActorIdentity } from "@sentry/junior/api/schema";
import { useLocalStorage } from "@uidotdev/usehooks";
import { Bot, Rows2, Rows3 } from "lucide-react";

import { useDashboardCoreData } from "../api";
import { ActorAvatar } from "../components/ActorAvatar";
import { participantName } from "../components/ParticipantAvatarStack";
import { cn } from "../styles";
import type { Conversation } from "../types";

/** How tall Conversation rows are. Comfortable adds who takes part. */
export type ConversationDensity = "comfortable" | "compact";

/** The viewer's row density, kept in this browser. */
export function useConversationDensity() {
  return useLocalStorage<ConversationDensity>(
    "junior:conversations:density",
    "compact",
  );
}

function personKey(person: ActorIdentity): string {
  return (
    person.email?.trim().toLowerCase() ||
    person.slackUserId?.trim() ||
    participantName(person)
  );
}

/**
 * Who takes part, for a Comfortable row, as Google Wave showed it. The row
 * shows people only when the Conversation has another human or a child
 * agent, and never the viewer alone. The viewer is left out of the stack.
 */
export function conversationCast(
  conversation: Conversation,
  viewerEmail: string | undefined,
): { agents: number; others: ActorIdentity[] } | undefined {
  const people = new Map<string, ActorIdentity>();
  for (const person of conversation.participants ?? []) {
    people.set(personKey(person), person);
  }
  const viewer = viewerEmail?.trim().toLowerCase();
  const others = [...people.values()].filter(
    (person) => person.email?.trim().toLowerCase() !== viewer,
  );
  const agents = conversation.childAgentTotals?.count ?? 0;
  if (others.length === 0 && agents === 0) return undefined;
  return { agents, others };
}

/** The second line of a Comfortable row: other people, then agents. */
export function ConversationCast(props: { conversation: Conversation }) {
  const viewerEmail = useDashboardCoreData().data?.me.user.email;
  const cast = conversationCast(props.conversation, viewerEmail);
  if (!cast) return null;
  const visible = cast.others.slice(0, 3);
  const names = cast.others.map(participantName);
  const label = [
    ...(names.length > 0 ? [`With ${names.join(", ")}`] : []),
    ...(cast.agents > 0
      ? [`${cast.agents} agent${cast.agents === 1 ? "" : "s"}`]
      : []),
  ].join(" · ");
  return (
    <span
      aria-label={label}
      className="flex min-w-0 items-center gap-1.5 text-xs text-dashboard-text-muted"
      role="img"
    >
      {visible.length > 0 ? (
        <span aria-hidden="true" className="inline-flex items-center">
          {visible.map((person) => (
            <span
              className="-ml-1 inline-flex rounded-full ring-2 ring-dashboard-surface-panel first:ml-0"
              key={personKey(person)}
            >
              <ActorAvatar
                imageUrl={person.avatarUrl}
                name={participantName(person)}
                size="list"
              />
            </span>
          ))}
        </span>
      ) : null}
      <span aria-hidden="true" className="min-w-0 truncate">
        {names.length > 0
          ? names.length > 3
            ? `${names[0]} +${names.length - 1}`
            : names.map((name) => name.split(" ")[0]).join(", ")
          : null}
      </span>
      {cast.agents > 0 ? (
        <span
          aria-hidden="true"
          className="inline-flex shrink-0 items-center gap-1"
        >
          <Bot className="size-3" />
          {cast.agents}
        </span>
      ) : null}
    </span>
  );
}

/** Switch the list between Compact and Comfortable rows. */
export function ConversationDensityToggle(props: { className?: string }) {
  const [density, setDensity] = useConversationDensity();
  const options = [
    { Icon: Rows3, label: "Compact", value: "compact" },
    { Icon: Rows2, label: "Comfortable", value: "comfortable" },
  ] as const;
  return (
    <div
      aria-label="Row density"
      className={cn("inline-flex items-center gap-0.5", props.className)}
      role="radiogroup"
    >
      {options.map(({ Icon, label, value }) => (
        <button
          aria-checked={density === value}
          aria-label={label}
          className={cn(
            "grid size-6 cursor-pointer place-items-center rounded-md border-0 bg-transparent p-0 transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus",
            density === value
              ? "bg-dashboard-fill-strong text-dashboard-text"
              : "text-dashboard-text-faint hover:text-dashboard-text",
          )}
          key={value}
          onClick={() => setDensity(value)}
          role="radio"
          title={label}
          type="button"
        >
          <Icon aria-hidden="true" className="size-3.5" />
        </button>
      ))}
    </div>
  );
}
