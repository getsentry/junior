import { codeChangeStateSchema } from "@sentry/junior-plugin-api";
import * as z from "zod";

import { composerTokenFinder } from "./composerTypeaheadToken";
import { CONVERSATION_PATH } from "./conversationRoutes";

/**
 * Something other than a person that a composer chip stands for. Its
 * message text is `referenceText`. `state` and `draft` are what the menu
 * knew at insert time. A reference read back from text has neither.
 */
export const composerReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.enum(["conversation", "task"]),
      // The same-origin link, as it is in the message text.
      url: z.string().min(1),
      title: z.string().min(1),
      state: z.enum(["needs_you", "working", "watching", "pinned"]).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("code_change"),
      url: z.string().min(1),
      /** `owner/repo`. */
      repository: z.string().min(1),
      number: z.number().int(),
      state: codeChangeStateSchema.optional(),
      draft: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("channel"),
      channelId: z.string().min(1),
      name: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("memory"),
      // The same-origin link of the memory page.
      url: z.string().min(1),
      // The start of the memory text, on one line.
      title: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("file"), name: z.string().min(1) }).strict(),
]);

export type ComposerReference = z.output<typeof composerReferenceSchema>;

/**
 * Find the `#name` reference that a caret is in, if any. Like `@`, a
 * letter, digit, `_` or `#` before the `#` makes it part of a word, and a
 * `/` or `&` makes it part of a URL or an entity, so `a#b`,
 * `https://x.com/#top` and `&#39;` open no menu.
 */
export const hashTokenAt = composerTokenFinder(
  String.raw`(?<![\p{L}\p{N}_#/&])#`,
  String.raw`[\p{L}\p{N}._/-]`,
  "u",
);

/**
 * The message text of a reference: a Slack link or channel token that the
 * transcript renders, or a file name. A link label cannot hold `<` or `>`.
 */
export function referenceText(reference: ComposerReference): string {
  switch (reference.kind) {
    case "conversation":
    case "task":
    case "memory":
      return `<${reference.url}|${reference.title}>`;
    case "code_change":
      return `<${reference.url}|${codeChangeLabel(reference)}>`;
    case "channel":
      return `<#${reference.channelId}|${reference.name}>`;
    case "file":
      return reference.name;
  }
}

/** `owner/repo#123`, the label of a pull request link. */
export function codeChangeLabel(change: {
  number: number;
  repository: string;
}): string {
  return `${change.repository}#${change.number}`;
}

/** A link label for a title: one line, without the characters that end a link. */
export function linkLabel(title: string): string {
  return title.replace(/[<>\s]+/g, " ").trim();
}

/** One part of composer text: plain text, a person, or a reference. */
export type ComposerTextPart =
  | { text: string }
  | { slackUserId: string }
  | { reference: ComposerReference };

// The tokens that core keeps in message text. A person mention has no
// label: the composer writes none, so text that it reads back keeps the
// same characters.
const TOKEN =
  /<@([A-Z0-9]+)>|<#(C[A-Z0-9]+)\|([^<>|]+)>|<(https?:\/\/[^\s|<>]+)\|([^<>]+)>/g;
const PULL_REQUEST_PATH = /^\/([^/]+\/[^/]+)\/pull\/(\d+)$/;
const MEMORY_PATH = /^\/memories\/[^/]+$/;

/**
 * Split message text into plain text, mentions, and references. A link is
 * a reference only when it is a Conversation or memory link of `origin`, or
 * a GitHub pull request link labeled `owner/repo#123`. Other links stay
 * text.
 */
export function splitComposerText(
  text: string,
  origin: string,
): ComposerTextPart[] {
  const parts: ComposerTextPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(TOKEN)) {
    const [token, slackUserId, channelId, name, url, label] = match;
    const part: ComposerTextPart | undefined = slackUserId
      ? { slackUserId }
      : channelId && name
        ? { reference: { kind: "channel", channelId, name } }
        : linkReference(url!, label!, origin);
    if (!part) continue;
    if (match.index > cursor) {
      parts.push({ text: text.slice(cursor, match.index) });
    }
    parts.push(part);
    cursor = match.index + token.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}

function linkReference(
  url: string,
  label: string,
  origin: string,
): { reference: ComposerReference } | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  if (parsed.search || parsed.hash) return undefined;
  if (parsed.origin === origin && CONVERSATION_PATH.test(parsed.pathname)) {
    return { reference: { kind: "conversation", url, title: label } };
  }
  if (parsed.origin === origin && MEMORY_PATH.test(parsed.pathname)) {
    return { reference: { kind: "memory", url, title: label } };
  }
  const pull =
    parsed.origin === "https://github.com"
      ? PULL_REQUEST_PATH.exec(parsed.pathname)
      : undefined;
  if (!pull) return undefined;
  const change = { repository: pull[1]!, number: Number(pull[2]) };
  // Another label is the writer's own text, so it stays.
  if (label !== codeChangeLabel(change)) return undefined;
  return { reference: { kind: "code_change", url, ...change } };
}
