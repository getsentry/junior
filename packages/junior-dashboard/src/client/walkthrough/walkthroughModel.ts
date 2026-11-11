import {
  codeExcerptId,
  type WalkthroughAnswerResponse,
  type WalkthroughChapter,
  type WalkthroughDocument,
  type WalkthroughEvidence,
  type WalkthroughExcerpt,
  type WalkthroughUpdate,
  type WalkthroughVersionResponse,
} from "@sentry/junior/api/schema";

import {
  answerState,
  feedbackItem,
  walkthroughChapters,
} from "./walkthroughUpdates";

type Check = WalkthroughDocument["checks"][number];
type Message = WalkthroughDocument["messages"][number];

/** The chapter title. The caption under it says what the chapter shows. */
export function chapterTitle(chapter: WalkthroughChapter): string {
  return chapter.label;
}

/** Files the story leaves out, by reason, from the story and its updates. */
export function alsoChanged(
  document: WalkthroughDocument,
): WalkthroughDocument["content"]["also_changed"] {
  const groups = new Map<string, { pr: number; path: string }[]>();
  for (const group of [
    ...document.content.also_changed,
    ...document.updates.flatMap((update) => update.also_changed),
  ]) {
    const files = groups.get(group.reason) ?? [];
    for (const file of group.files) {
      if (!files.some((f) => f.pr === file.pr && f.path === file.path)) {
        files.push(file);
      }
    }
    groups.set(group.reason, files);
  }
  return [...groups].map(([reason, files]) => ({ reason, files }));
}

/** One numbered piece of chapter evidence, resolved against the document. */
export type CitedEvidence =
  | {
      kind: "code";
      n: number;
      evidence: WalkthroughEvidence & { kind: "code" };
      excerpt: WalkthroughExcerpt;
    }
  | { kind: "message"; n: number; message: Message }
  | { kind: "link"; n: number; label: string; url: string }
  | { kind: "check"; n: number; check: Check };

/**
 * Resolve evidence in prose order, so "[2]" is the second item. Evidence that
 * the document cannot resolve keeps its number and shows nothing.
 */
export function citedEvidence(
  document: WalkthroughDocument,
  evidence: readonly WalkthroughEvidence[],
): CitedEvidence[] {
  const excerpts = new Map(document.excerpts.map((e) => [e.id, e]));
  return evidence.flatMap((e, index): CitedEvidence[] => {
    const n = index + 1;
    switch (e.kind) {
      case "code": {
        const excerpt = excerpts.get(codeExcerptId(e));
        return excerpt ? [{ kind: "code", n, evidence: e, excerpt }] : [];
      }
      case "message": {
        const message = document.messages.find((m) => m.seq === e.seq);
        return message ? [{ kind: "message", n, message }] : [];
      }
      case "link":
        return [{ kind: "link", n, label: e.label, url: e.url }];
      case "check": {
        const check = document.checks.find((c) => c.id === e.check_id);
        return check ? [{ kind: "check", n, check }] : [];
      }
    }
  });
}

/** Layers that a chapter's code cites. */
function evidencePrs(evidence: readonly WalkthroughEvidence[]): number[] {
  return [
    ...new Set(evidence.flatMap((e) => (e.kind === "code" ? [e.pr] : []))),
  ];
}

/** The code change a reader starts a Walkthrough from. */
export type WalkthroughTarget = {
  provider: string;
  repository: string;
  number: number;
};

/**
 * The target that starts this version again. Any layer names the whole
 * stack, so the top layer stands for it.
 */
export function versionTarget(
  version: WalkthroughVersionResponse,
): WalkthroughTarget | undefined {
  const top = version.codeChanges.at(-1);
  return top
    ? {
        provider: version.provider,
        repository: version.repository,
        number: top.number,
      }
    : undefined;
}

/** The viewer's answers, by decision id. */
export type AnswerMap = Readonly<Record<string, WalkthroughAnswerResponse>>;

/** One decision a reviewer answers, with the chapter that asks it. */
export type ReviewDecision = {
  id: string;
  /** The statement the reviewer agrees with or asks to change. */
  claim: string;
  /** What could make the claim wrong. */
  concern?: string;
  chapterId: string;
  chapterIndex: number;
  /** Layers this decision is about. */
  prs: number[];
  /** Where feedback lands in the code: the full path and line. */
  location?: { label: string; url?: string };
};

/**
 * Every decision in reading order. Decisions that updates add sit with the
 * chapter they touch.
 */
export function reviewDecisions(
  document: WalkthroughDocument,
): ReviewDecision[] {
  const excerpts = new Map(document.excerpts.map((e) => [e.id, e]));
  const allPrs = document.layers.map((layer) => layer.pr);
  const chapters = walkthroughChapters(document);
  const indexOf = new Map(chapters.map((c, index) => [c.id, index]));
  const items = document.updates.flatMap((update) => update.items);
  return chapters.flatMap((chapter, chapterIndex) =>
    [
      { evidence: chapter.evidence, decisions: chapter.decisions },
      ...items
        .filter((item) => indexOf.get(item.touches) === chapterIndex)
        .map((item) => ({
          evidence: item.evidence,
          decisions: item.decisions,
        })),
    ].flatMap(({ evidence, decisions }) =>
      decisions.map((decision) => {
        const own =
          decision.evidence === undefined
            ? undefined
            : evidence[decision.evidence];
        // A decision about prose is about the chapter's first code, and one
        // with no code at all is about every layer.
        const code =
          own?.kind === "code" ? own : evidence.find((e) => e.kind === "code");
        const prs = own ? evidencePrs([own]) : evidencePrs(evidence);
        return {
          id: decision.id,
          claim: decision.claim,
          ...(decision.concern ? { concern: decision.concern } : undefined),
          chapterId: chapter.id,
          chapterIndex,
          prs: prs.length ? prs : allPrs,
          ...(code?.kind === "code"
            ? {
                location: {
                  label: `${code.path}:${code.start}`,
                  url: excerpts.get(codeExcerptId(code))?.url,
                },
              }
            : undefined),
        };
      }),
    ),
  );
}

/**
 * Split the viewer's answers on this lineage into the ones that still hold
 * and the ones that an update reopened. A reopened answer is context: the
 * code it judged changed. A change request that an update answers reopens
 * too, so the reviewer can say whether the change answers it. A skip judged
 * nothing, so once its code changes the decision is simply open again.
 */
export function reviewAnswers(
  document: WalkthroughDocument,
  decisions: readonly ReviewDecision[],
  answers: AnswerMap,
): {
  current: AnswerMap;
  reopened: AnswerMap;
  feedback: Readonly<Record<string, WalkthroughUpdate["items"][number]>>;
} {
  const current: Record<string, WalkthroughAnswerResponse> = {};
  const reopened: Record<string, WalkthroughAnswerResponse> = {};
  const feedback: Record<string, WalkthroughUpdate["items"][number]> = {};
  for (const decision of decisions) {
    const answer = answers[decision.id];
    if (!answer) continue;
    const item = feedbackItem(document, decision.id, answer);
    if (item) feedback[decision.id] = item;
    if (
      item ||
      answerState(document, decision.chapterId, answer) === "reopened"
    ) {
      if (answer.value !== "skip") reopened[decision.id] = answer;
    } else {
      current[decision.id] = answer;
    }
  }
  return { current, reopened, feedback };
}

/** Decisions the viewer has not answered or skipped yet. */
export function openDecisionCount(
  decisions: readonly ReviewDecision[],
  answers: AnswerMap,
): number {
  return decisions.filter((d) => !answers[d.id]).length;
}

/**
 * One layer's review as GitHub Markdown. It pastes into the PR's review box
 * as is: code locations link to the cited line at the reviewed commit.
 * Skipped decisions stay out.
 */
export function reviewMarkdown(args: {
  answers: AnswerMap;
  comment: string;
  decisions: readonly ReviewDecision[];
  pr: number;
}): string {
  const mine = args.decisions.filter((d) => d.prs.includes(args.pr));
  const changes = mine.filter((d) => args.answers[d.id]?.value === "change");
  const agreed = mine.filter((d) => args.answers[d.id]?.value === "agree");
  const sections: string[] = [];
  if (args.comment.trim()) sections.push(args.comment.trim());
  if (changes.length) {
    sections.push(
      [
        "**Changes requested**",
        ...changes.map((d, index) => {
          const note = args.answers[d.id]?.note;
          const where = d.location ? ` (${markdownLocation(d.location)})` : "";
          return note
            ? `${index + 1}. ${note}${where}\n   > ${d.claim}`
            : `${index + 1}. ${d.claim}${where}`;
        }),
      ].join("\n\n"),
    );
  }
  if (agreed.length) {
    sections.push(
      ["**Agreed**", ...agreed.map((d) => `- ${d.claim}`)].join("\n"),
    );
  }
  return sections.join("\n\n");
}

function markdownLocation(location: { label: string; url?: string }): string {
  return location.url
    ? `[\`${location.label}\`](${location.url})`
    : `\`${location.label}\``;
}

/** The chapter that a question is about, as the question quotes it. */
export type QuestionChapter = { title: string };

/**
 * Write a question about one chapter. The quote line names the chapter by
 * its title, which is unique, so the agent and the transcript both see it.
 */
export function chapterQuestion(
  chapter: QuestionChapter | undefined,
  text: string,
): string {
  if (!chapter) return text;
  return `> **${chapter.title}**\n\n${text}`;
}

const CHAPTER_QUOTE = /^> \*\*(.+?)\*\*\n\n/;

/** Split a question into its chapter title, if it names one, and its text. */
export function readChapterQuestion(message: string): {
  chapter?: string;
  text: string;
} {
  const match = CHAPTER_QUOTE.exec(message);
  if (!match) return { text: message };
  return { chapter: match[1], text: message.slice(match[0].length) };
}
