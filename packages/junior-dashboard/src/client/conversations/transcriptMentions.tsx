import { createContext, useContext, type ReactNode } from "react";
import { Link } from "react-router";
import type { ActorIdentity } from "@sentry/junior/api/schema";

import { peoplePath } from "../format";
import type { TranscriptViewMessage } from "../types";
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

/** Share the people that the API resolved for mentions in one transcript. */
export function TranscriptMentionPeopleProvider(props: {
  children: ReactNode;
  messages: readonly TranscriptViewMessage[];
}) {
  const people = new Map<string, ActorIdentity>();
  for (const message of props.messages) {
    for (const person of message.mentions ?? []) {
      if (person.slackUserId) people.set(person.slackUserId, person);
    }
  }
  return (
    <TranscriptMentionPeople.Provider value={people}>
      {props.children}
    </TranscriptMentionPeople.Provider>
  );
}

/** Render text with Slack `<@U123>` and `<#C123|name>` tokens as readable mentions. */
export function renderMentionText(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const mention of findMentions(text)) {
    if (mention.start > cursor) {
      nodes.push(
        <HighlightText
          key={`${keyBase}-m-${cursor}`}
          text={text.slice(cursor, mention.start)}
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
        text={text.slice(cursor)}
      />,
    );
  }
  return nodes;
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

function MentionView(props: { mention: TranscriptMention }) {
  const people = useContext(TranscriptMentionPeople);
  const { id, label, sigil } = props.mention;
  const person = sigil === "@" ? people.get(id) : undefined;
  const name = person?.fullName ?? person?.slackUserName ?? label ?? id;
  const text = <HighlightText text={`${sigil}${name.replace(/^[@#]/, "")}`} />;
  if (person?.email) {
    return (
      <Link
        className={TRANSCRIPT_ANCHOR_CLASS}
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
