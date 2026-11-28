import { expect, it } from "vitest";

import {
  composerReferenceSchema,
  hashTokenAt,
  linkedWorkUrls,
  referenceText,
  splitComposerText,
} from "../src/client/conversations/composerReferences";

const ORIGIN = "https://junior.example.com";

// `|` marks the caret.
const at = (text: string) => {
  const caret = text.indexOf("|");
  return hashTokenAt(text.slice(0, caret) + text.slice(caret + 1), caret);
};

// No describe block: CI parses the JUnit report, and each " > " in a test
// name adds an XML entity toward the parser's limit.
it("finds the # reference at the caret", () => {
  expect(at("see #38|")).toEqual({ start: 4, end: 7, query: "38" });
  expect(at("(#proj-ju|nior)")).toEqual({
    start: 1,
    end: 13,
    query: "proj-ju",
  });
  expect(at("#getsentry/jun|")).toEqual({
    start: 0,
    end: 14,
    query: "getsentry/jun",
  });
  // An empty query has a reference, but the menu opens only with a name.
  expect(at("# |heading")).toBeUndefined();
  expect(at("#|")).toEqual({ start: 0, end: 1, query: "" });
  expect(at("see #link pull|")).toEqual({
    start: 4,
    end: 14,
    query: "link pull",
  });
  // The word after a trailing space is not in the reference.
  expect(at("see #38 |world")).toEqual({ start: 4, end: 8, query: "38 " });
});

it("skips a # in a word, a URL, an entity, or a heading", () => {
  expect(at("a#b|")).toBeUndefined();
  expect(at("C#|")).toBeUndefined();
  expect(at("https://x.com/page#top|")).toBeUndefined();
  expect(at("https://x.com/#top|")).toBeUndefined();
  expect(at("&#39|")).toBeUndefined();
  expect(at("##x|")).toBeUndefined();
  expect(at("#x  |")).toBeUndefined();
});

it("splits mentions and references out of message text", () => {
  const conversation = `${ORIGIN}/conversations/slack%3AC1%3A1.2`;
  const pull = "https://github.com/getsentry/junior/pull/3842";
  expect(
    splitComposerText(
      `hi <@U789>, see <${conversation}|Checkout triage> and <${pull}|getsentry/junior#3842> in <#C123|proj-junior>`,
      ORIGIN,
    ),
  ).toEqual([
    { text: "hi " },
    { slackUserId: "U789" },
    { text: ", see " },
    {
      reference: {
        kind: "conversation",
        title: "Checkout triage",
        url: conversation,
      },
    },
    { text: " and " },
    {
      reference: {
        kind: "code_change",
        number: 3842,
        repository: "getsentry/junior",
        url: pull,
      },
    },
    { text: " in " },
    { reference: { kind: "channel", channelId: "C123", name: "proj-junior" } },
  ]);
});

it("keeps other links and labels as text", () => {
  for (const text of [
    "no <@mention> here",
    "<https://other.example.com/conversations/a|Elsewhere>",
    `<${ORIGIN}/conversations/a?message=1|With a query>`,
    `<${ORIGIN}/people/a|A person>`,
    "<https://other.example.com/memories/a|Elsewhere>",
    "<https://github.com/getsentry/junior/pull/1|my fix>",
    "<https://github.com/getsentry/junior/issues/1|getsentry/junior#1>",
    "<#C123> and <https://example.com|a page>",
  ]) {
    expect(splitComposerText(text, ORIGIN)).toEqual([{ text }]);
  }
});

it("writes each reference as the token that it reads back from", () => {
  const references = [
    {
      kind: "task" as const,
      title: "Review the plan",
      url: `${ORIGIN}/conversations/junior%3At`,
    },
    {
      kind: "code_change" as const,
      draft: true,
      number: 15120,
      repository: "getsentry/sentry-docs",
      state: "open" as const,
      url: "https://github.com/getsentry/sentry-docs/pull/15120",
    },
    { kind: "channel" as const, channelId: "C456", name: "proj-release" },
    {
      kind: "memory" as const,
      title: "Use pnpm for repository commands.",
      url: `${ORIGIN}/memories/memory-pnpm`,
    },
  ];
  const text = references.map(referenceText).join(" ");
  expect(text).toBe(
    `<${ORIGIN}/conversations/junior%3At|Review the plan> <https://github.com/getsentry/sentry-docs/pull/15120|getsentry/sentry-docs#15120> <#C456|proj-release> <${ORIGIN}/memories/memory-pnpm|Use pnpm for repository commands.>`,
  );
  expect(
    splitComposerText(text, ORIGIN).flatMap((part) =>
      "reference" in part ? [referenceText(part.reference)] : [],
    ),
  ).toEqual(references.map(referenceText));
  // A file is its name, which reads back as text.
  expect(referenceText({ kind: "file", name: "chart.png" })).toBe("chart.png");
});

it("lists the links that a message sends, once each", () => {
  const conversation = `${ORIGIN}/conversations/a`;
  const pull = "https://github.com/getsentry/junior/pull/3842";
  const doc = "https://docs.google.com/document/d/1abc/edit";
  const page = "https://example.com/notes";
  // A memory or a person is not work. Any other link goes to the API, which
  // attaches only a link that names an object.
  expect(
    linkedWorkUrls(
      `<${conversation}|A> <${pull}|getsentry/junior#3842> <#C1|ops> <${ORIGIN}/memories/m|M> read ${doc}, then <${page}|the notes>. <${conversation}|A again> ${doc} dev@example.com`,
      ORIGIN,
    ),
  ).toEqual([conversation, pull, doc, page]);
});

it("reads a draft reference saved with the old needs_you state", () => {
  const reference = { kind: "conversation", title: "Plan", url: "/c/1" };
  expect(
    composerReferenceSchema.parse({ ...reference, state: "needs_you" }),
  ).toEqual({ ...reference, state: "needs_input" });
  expect(composerReferenceSchema.parse(reference)).toEqual(reference);
});
