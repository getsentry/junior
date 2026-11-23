import type { ActorIdentity } from "@sentry/junior/api/schema";
import { useEffect } from "react";
import { Bot, Rows2, Rows3 } from "lucide-react";

import { useDashboardCoreData } from "../api";
import { ActorAvatar } from "../components/ActorAvatar";
import { browserChoice } from "../browserChoice";
import type { BrowserPreference } from "../components/PreferenceToggle";
import { participantName } from "../components/ParticipantAvatarStack";
import type { Conversation } from "../types";

/** How roomy the dashboard is. Comfortable adds who takes part to rows. */
type ConversationDensity = "comfortable" | "compact";

/**
 * The viewer's density, kept in this browser. Rows and the
 * transcript follow it: components read it here, and CSS reads the root's
 * `data-density` through the `comfortable:` variant.
 */
export const useConversationDensity = browserChoice<ConversationDensity>(
  "junior:density",
  ["comfortable"],
  "compact",
);

/** Mirror the density on the root, for the `comfortable:` CSS variant. */
export function useDensityRoot(): void {
  const [density] = useConversationDensity();
  useEffect(() => {
    const root = document.documentElement;
    root.dataset["density"] = density;
    // The current UI has no density, so leaving the new UI clears it.
    return () => {
      delete root.dataset["density"];
    };
  }, [density]);
}

/** This browser's dashboard density: compact or comfortable. */
export const densityPreference: BrowserPreference<ConversationDensity> = {
  choices: [
    { Icon: Rows3, label: "Compact", value: "compact" },
    { Icon: Rows2, label: "Comfortable", value: "comfortable" },
  ],
  label: "Density",
  useChoice: useConversationDensity,
};

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
function conversationCast(
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
export function ConversationCast(props: {
  /** Whether to count the Threads; off where the row lists them. */
  agents?: boolean;
  conversation: Conversation;
}) {
  const viewerEmail = useDashboardCoreData().data?.me.user.email;
  const found = conversationCast(props.conversation, viewerEmail);
  const cast =
    found && props.agents === false ? { ...found, agents: 0 } : found;
  if (!cast || (cast.others.length === 0 && cast.agents === 0)) return null;
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
