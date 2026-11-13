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
  /** A verified linked GitHub login, from account linking only. */
  githubHandle?: string;
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
      ...(args.githubHandle ? { githubHandle: args.githubHandle } : undefined),
      ...(person.avatarUrl ? { avatarUrl: person.avatarUrl } : undefined),
    },
  };
}

// Long enough to know the message, short enough to never copy a whole one.
const MAX_SNIPPET_CHARS = 280;
const MAX_TITLE_CHARS = 100;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * Build the card of one chat message. Give `text` only when the viewer may
 * read the message: the card shows a short snippet of it, never all of it.
 */
export function messageObjectCard(args: {
  author?: string;
  /** Where the message is, such as `#general` or `Direct message`. */
  channel: string;
  key: string;
  sentAt?: string;
  text?: string;
  url: string;
}): ObjectAnnotation {
  const snippet = args.text?.replace(/\s+/g, " ").trim();
  const title = snippet
    ? truncate(snippet, MAX_TITLE_CHARS)
    : `Message in ${args.channel}`;
  return {
    kind: "object",
    objectType: "message",
    key: args.key.slice(0, 256),
    label: args.channel.slice(0, MAX_LABEL_CHARS),
    title,
    url: args.url,
    ...(snippet && snippet.length > title.length
      ? { description: truncate(snippet, MAX_SNIPPET_CHARS) }
      : undefined),
    facts: {
      type: "message",
      channel: args.channel.slice(0, MAX_FACT_CHARS),
      ...(args.author
        ? { author: args.author.slice(0, MAX_FACT_CHARS) }
        : undefined),
      ...(args.sentAt ? { sentAt: args.sentAt } : undefined),
    },
  };
}

/**
 * Build the card of one public web page from its oEmbed fields or meta
 * tags. `thumbnailUrl` must be a Junior image path.
 */
export function webPageObjectCard(args: {
  author?: string;
  description?: string;
  siteName?: string;
  thumbnailUrl?: string;
  title: string;
  url: string;
}): ObjectAnnotation {
  return {
    kind: "object",
    objectType: "web_page",
    key: args.url.slice(0, 256),
    label: truncate(args.title, MAX_LABEL_CHARS),
    title: truncate(args.title, 512),
    url: args.url,
    ...(args.description
      ? { description: truncate(args.description, MAX_SNIPPET_CHARS) }
      : undefined),
    facts: {
      type: "web_page",
      ...(args.siteName
        ? { siteName: truncate(args.siteName, MAX_FACT_CHARS) }
        : undefined),
      ...(args.author
        ? { author: truncate(args.author, MAX_FACT_CHARS) }
        : undefined),
      ...(args.thumbnailUrl ? { thumbnailUrl: args.thumbnailUrl } : undefined),
    },
  };
}
