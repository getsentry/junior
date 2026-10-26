import { createContext, useContext, type ReactNode } from "react";

import type { TranscriptViewMessage } from "../types";
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

const TranscriptMentionNames = createContext<ReadonlyMap<string, string>>(
  new Map(),
);

/** Share Slack user names that are known from transcript message actors. */
export function TranscriptMentionNamesProvider(props: {
  children: ReactNode;
  messages: readonly TranscriptViewMessage[];
}) {
  const names = new Map<string, string>();
  for (const message of props.messages) {
    const actor = message.actorIdentity;
    const id = actor?.slackUserId?.trim();
    const name = actor?.fullName?.trim() || actor?.slackUserName?.trim();
    if (id && name && !names.has(id)) names.set(id, name);
  }
  return (
    <TranscriptMentionNames.Provider value={names}>
      {props.children}
    </TranscriptMentionNames.Provider>
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
  const names = useContext(TranscriptMentionNames);
  const { id, label, sigil } = props.mention;
  const name = (sigil === "@" ? names.get(id) : undefined) ?? label ?? id;
  return (
    <span
      className="rounded-[0.25rem] bg-dashboard-accent/15 px-0.5 font-medium text-dashboard-accent-text"
      title={id}
    >
      <HighlightText text={`${sigil}${name.replace(/^[@#]/, "")}`} />
    </span>
  );
}
