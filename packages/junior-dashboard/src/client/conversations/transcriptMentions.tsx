import { createContext, useContext, type ReactNode } from "react";
import { Link } from "react-router";
import type { ActorIdentity } from "@sentry/junior/api/schema";

import { peoplePath } from "../format";
import { cn } from "../styles";
import { replaceSlackEmoji } from "./transcriptEmoji";
import { TRANSCRIPT_ANCHOR_CLASS } from "./transcriptMarkdownLinks";
import { HighlightText } from "./transcriptSearch";

type TranscriptMention = {
  end: number;
  id: string;
  label?: string;
  sigil: "@" | "#";
  start: number;
};

// Matches the user and channel tokens that core keeps in message text.
const SLACK_MENTION_RE = /<([@#])([A-Z0-9]+)(?:\|([^<>]*))?>/g;

const TranscriptMentionPeople = createContext<
  ReadonlyMap<string, ActorIdentity>
>(new Map());

/**
 * Share the people that the API resolved for one block of display text.
 * Use `TranscriptText` or `MentionText`, which require the API mentions.
 */
export function MentionPeopleProvider(props: {
  children: ReactNode;
  mentions: readonly ActorIdentity[];
}) {
  return (
    <TranscriptMentionPeople.Provider value={mentionPeople(props.mentions)}>
      {props.children}
    </TranscriptMentionPeople.Provider>
  );
}

/** Render one line of display text with the people the API resolved for it. */
export function MentionText(props: {
  /**
   * Link people to their page. Set false inside a button, which cannot hold
   * a link.
   */
  links?: boolean;
  mentions: readonly ActorIdentity[];
  text: string;
}) {
  return (
    <MentionPeopleProvider mentions={props.mentions}>
      {renderMentionText(props.text, "mention-text", props.links)}
    </MentionPeopleProvider>
  );
}

/**
 * Render text with Slack `<@U123>` and `<#C123|name>` tokens as readable
 * mentions and Slack `:name:` codes as emoji. It reads people from the
 * nearest `MentionPeopleProvider`.
 */
export function renderMentionText(
  text: string,
  keyBase: string,
  links = true,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const mention of findMentions(text)) {
    if (mention.start > cursor) {
      nodes.push(
        <HighlightText
          key={`${keyBase}-m-${cursor}`}
          text={replaceSlackEmoji(text.slice(cursor, mention.start))}
        />,
      );
    }
    nodes.push(
      <MentionView
        key={`${keyBase}-m-${mention.start}`}
        links={links}
        mention={mention}
      />,
    );
    cursor = mention.end;
  }
  if (cursor < text.length) {
    nodes.push(
      <HighlightText
        key={`${keyBase}-m-${cursor}`}
        text={replaceSlackEmoji(text.slice(cursor))}
      />,
    );
  }
  return nodes;
}

/**
 * Return display text as one plain string, with the same names and emoji
 * that `MentionText` shows. Use it where markup cannot go, such as a title.
 */
export function mentionPlainText(
  text: string,
  mentions: readonly ActorIdentity[],
): string {
  const people = mentionPeople(mentions);
  let result = "";
  let cursor = 0;
  for (const mention of findMentions(text)) {
    result += replaceSlackEmoji(text.slice(cursor, mention.start));
    result += mentionLabel(mention, people);
    cursor = mention.end;
  }
  return result + replaceSlackEmoji(text.slice(cursor));
}

function mentionPeople(
  mentions: readonly ActorIdentity[],
): Map<string, ActorIdentity> {
  const people = new Map<string, ActorIdentity>();
  for (const person of mentions) {
    if (person.slackUserId) people.set(person.slackUserId, person);
  }
  return people;
}

function mentionLabel(
  mention: TranscriptMention,
  people: ReadonlyMap<string, ActorIdentity>,
): string {
  const { id, label, sigil } = mention;
  const person = sigil === "@" ? people.get(id) : undefined;
  const name = person?.fullName ?? person?.slackUserName ?? label ?? id;
  return `${sigil}${name.replace(/^[@#]/, "")}`;
}

function findMentions(text: string): TranscriptMention[] {
  return [...text.matchAll(SLACK_MENTION_RE)].map((match) => ({
    end: match.index + match[0].length,
    id: match[2]!,
    label: match[3]?.trim() || undefined,
    sigil: match[1] as "@" | "#",
    start: match.index,
  }));
}

function MentionView(props: { links: boolean; mention: TranscriptMention }) {
  const people = useContext(TranscriptMentionPeople);
  const { id, sigil } = props.mention;
  const person = sigil === "@" ? people.get(id) : undefined;
  const text = <HighlightText text={mentionLabel(props.mention, people)} />;
  if (props.links && person?.email) {
    return (
      <Link
        // Previews sit in cards that disable pointer events on their text.
        className={cn("pointer-events-auto", TRANSCRIPT_ANCHOR_CLASS)}
        title={id}
        to={peoplePath(person.email)}
      >
        {text}
      </Link>
    );
  }
  return (
    <span className="font-medium text-dashboard-accent-text" title={id}>
      {text}
    </span>
  );
}
