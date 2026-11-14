import { createContext, useContext, type ReactNode } from "react";
import { Link } from "react-router";
import type { ActorIdentity } from "@sentry/junior/api/schema";

import { HighlightText } from "../conversations/transcriptSearch";
import { peoplePath } from "../format";
import { cn } from "../styles";
import { replaceSlackEmoji } from "./emoji";
import { ANCHOR_CLASS } from "./links";
import { PersonMention } from "./people";

type Mention = {
  end: number;
  id: string;
  label?: string;
  sigil: "@" | "#";
  start: number;
};

type MentionContext = {
  links: boolean;
  people: ReadonlyMap<string, ActorIdentity>;
};

// Matches the user and channel tokens that core keeps in message text.
const SLACK_MENTION_RE = /<([@#])([A-Z0-9]+)(?:\|([^<>]*))?>/g;

const MentionPeople = createContext<MentionContext>({
  links: true,
  people: new Map(),
});

/** Share the people that the API resolved for one display text. */
export function MentionPeopleProvider(props: {
  children: ReactNode;
  links: boolean;
  mentions: readonly ActorIdentity[];
}) {
  return (
    <MentionPeople.Provider
      value={{ links: props.links, people: mentionPeople(props.mentions) }}
    >
      {props.children}
    </MentionPeople.Provider>
  );
}

/**
 * Render one text run with Slack `<@U123>` and `<#C123|name>` tokens as
 * readable mentions, Slack `:name:` codes as emoji, and search matches
 * highlighted. It reads people from the nearest `MentionPeopleProvider`.
 */
export function renderTextTokens(text: string, keyBase: string): ReactNode[] {
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
      <MentionView key={`${keyBase}-m-${mention.start}`} mention={mention} />,
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

/** Return one text run as a string, with the names and emoji it renders. */
export function plainTextTokens(
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
  mention: Mention,
  people: ReadonlyMap<string, ActorIdentity>,
): string {
  const { id, label, sigil } = mention;
  const person = sigil === "@" ? people.get(id) : undefined;
  const name = person?.fullName ?? person?.slackUserName ?? label ?? id;
  return `${sigil}${name.replace(/^[@#]/, "")}`;
}

function findMentions(text: string): Mention[] {
  return [...text.matchAll(SLACK_MENTION_RE)].map((match) => ({
    end: match.index + match[0].length,
    id: match[2]!,
    label: match[3]?.trim() || undefined,
    sigil: match[1] as "@" | "#",
    start: match.index,
  }));
}

function MentionView(props: { mention: Mention }) {
  const { links, people } = useContext(MentionPeople);
  const { id, sigil } = props.mention;
  const person = sigil === "@" ? people.get(id) : undefined;
  const text = <HighlightText text={mentionLabel(props.mention, people)} />;
  const name =
    links && person?.email ? (
      <Link
        // Previews sit in cards that disable pointer events on their text.
        className={cn("pointer-events-auto", ANCHOR_CLASS)}
        title={id}
        to={peoplePath(person.email)}
      >
        {text}
      </Link>
    ) : (
      <span className="font-medium text-dashboard-accent-text" title={id}>
        {text}
      </span>
    );
  if (!person) return name;
  return (
    <PersonMention avatarUrl={person.avatarUrl} email={person.email}>
      {name}
    </PersonMention>
  );
}
