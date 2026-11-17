import { createContext, useContext, type ReactNode } from "react";
import type { ActorIdentity } from "@sentry/junior/api/schema";

import { HighlightText } from "../conversations/transcriptSearch";
import { PersonReference } from "../components/PersonReference";
import { personFromActor } from "../person";
import { replaceSlackEmoji } from "./emoji";
import { ANCHOR_CLASS } from "./links";

type Mention = {
  end: number;
  id: string;
  label?: string | undefined;
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
  const actor = sigil === "@" ? people.get(id) : undefined;
  const label = mentionLabel(props.mention, people);
  const person = personFromActor(actor);
  if (!person) {
    return (
      <span className="font-medium text-dashboard-accent-text" title={id}>
        <HighlightText text={label} />
      </span>
    );
  }
  return (
    <PersonReference
      card={links}
      className={
        links && person.email
          ? ANCHOR_CLASS
          : "font-medium text-dashboard-accent-text"
      }
      highlightSelf
      label={<HighlightText text={label} />}
      person={person}
    />
  );
}

/**
 * Show one line of plain text, such as a title, with its Slack mentions as
 * people. Set `links={false}` inside a link or button.
 */
export function MentionText(props: {
  links?: boolean | undefined;
  mentions?: readonly ActorIdentity[] | undefined;
  text: string;
}) {
  return (
    <MentionPeopleProvider
      links={props.links ?? true}
      mentions={props.mentions ?? []}
    >
      {renderTextTokens(props.text, "mention-text")}
    </MentionPeopleProvider>
  );
}
