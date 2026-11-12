/**
 * Cards for the core link types. These functions only shape data that the
 * caller already read for the viewer, so the dashboard mocks can use them.
 */
import type { ObjectAnnotation } from "@sentry/junior-plugin-api";
import type {
  ActorIdentity,
  ConversationSummaryReport,
} from "../schema/conversation";

const MAX_LABEL_CHARS = 256;
// The length limit of one text fact.
const MAX_FACT_CHARS = 160;

const conversationStates = {
  active: "running",
  completed: "idle",
  failed: "failed",
  stopped: "stopped",
} satisfies Record<ConversationSummaryReport["status"], string>;

function personName(person: ActorIdentity): string | undefined {
  return person.fullName ?? person.slackUserName ?? person.email;
}

/**
 * Build the card of one Conversation that the viewer may read. Give `brief`
 * only when the viewer may see the Brief.
 */
export function conversationObjectCard(args: {
  brief?: string;
  participants: readonly ActorIdentity[];
  summary: Pick<
    ConversationSummaryReport,
    "archivedAt" | "conversationId" | "displayTitle" | "lastSeenAt" | "status"
  >;
  url: string;
}): ObjectAnnotation {
  const { summary } = args;
  const participants = args.participants
    .flatMap((person) => personName(person)?.slice(0, MAX_FACT_CHARS) ?? [])
    .slice(0, 5);
  return {
    kind: "object",
    objectType: "conversation",
    key: summary.conversationId.slice(0, 256),
    label: summary.displayTitle.slice(0, MAX_LABEL_CHARS),
    title: summary.displayTitle.slice(0, 512),
    url: args.url,
    status: summary.archivedAt
      ? "archived"
      : conversationStates[summary.status],
    ...(args.brief ? { description: args.brief.slice(0, 4000) } : undefined),
    facts: {
      type: "conversation",
      ...(participants.length > 0 ? { participants } : undefined),
      lastActivityAt: summary.lastSeenAt,
    },
  };
}

/** Build the card of one known person from what the People pages show. */
export function personObjectCard(args: {
  person: ActorIdentity & { email: string };
  url: string;
}): ObjectAnnotation {
  const { person } = args;
  const name = personName(person) ?? person.email;
  return {
    kind: "object",
    objectType: "person",
    key: person.email.toLowerCase().slice(0, 256),
    label: name.slice(0, MAX_LABEL_CHARS),
    title: name.slice(0, 512),
    url: args.url,
    facts: {
      type: "person",
      email: person.email.slice(0, MAX_FACT_CHARS),
      ...(person.slackUserName
        ? { slackHandle: person.slackUserName.slice(0, MAX_FACT_CHARS) }
        : undefined),
      ...(person.avatarUrl ? { avatarUrl: person.avatarUrl } : undefined),
    },
  };
}
