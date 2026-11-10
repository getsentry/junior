import type {
  WalkthroughAnswer,
  WalkthroughChapter,
  WalkthroughDocument,
  WalkthroughEvidence,
  WalkthroughHunk,
} from "@sentry/junior/api/schema";

export type WalkthroughUpdate = WalkthroughDocument["updates"][number];
export type WalkthroughUpdateItem = WalkthroughUpdate["items"][number];
type WalkthroughLayer = WalkthroughDocument["layers"][number];

/** One place the reader can stand: an old chapter or an update item. */
export type WalkthroughStep =
  | { kind: "chapter"; key: string; chapter: WalkthroughChapter }
  | {
      kind: "item";
      key: string;
      item: WalkthroughUpdateItem;
      update: WalkthroughUpdate;
    };

/** A decision the reader answers, with the layers it belongs to. */
export type ReviewDecision = {
  id: string;
  question: string;
  prs: number[];
  /** The step that shows this decision. */
  stepKey: string;
  /** What the question is about, when the question alone does not say. */
  context?: string;
  /** Update item that answers earlier "change" feedback on this decision. */
  answeredBy?: WalkthroughUpdateItem;
  location?: { label: string; url?: string };
};

export type AnswerMap = Record<
  string,
  Pick<WalkthroughAnswer, "value" | "note">
>;

export const slotLabels: Record<string, string> = {
  how_it_works: "How it works",
  gap: "The gap",
  change: "The change",
  broken: "What broke",
  cause: "The cause",
  fix: "The fix",
  side_effects: "Side effects",
  proof: "How we know it works",
  claim: "The claim",
  exceptions: "Exceptions",
  why: "Why",
  safe_to_run: "Safe to run?",
  rollback: "Rollback",
  what_changed: "What changed",
  blast_radius: "Blast radius",
  hot_path: "Hot path",
  numbers: "Numbers",
  before_after: "Before and after",
  after_ship: "After it ships",
};

export const typeLabels: Record<WalkthroughChapter["type"], string> = {
  feature: "Feature",
  bug_fix: "Bug fix",
  refactor: "Refactor",
  migration: "Migration",
  dependency: "Dependency",
  performance: "Performance",
  ui: "UI",
  ship_check: "Ship check",
};

/** Index hunks by id once per document. */
export function hunkIndex(
  document: WalkthroughDocument,
): ReadonlyMap<string, WalkthroughHunk> {
  return new Map(document.hunks.map((hunk) => [hunk.id, hunk]));
}

/** Layers cited by evidence. A chapter without code has no layer. */
export function evidencePrs(
  evidence: readonly WalkthroughEvidence[],
  hunks: ReadonlyMap<string, WalkthroughHunk>,
): number[] {
  const prs = new Set<number>();
  for (const e of evidence) {
    if (e.kind === "hunk") {
      const hunk = hunks.get(e.hunkId);
      if (hunk) prs.add(hunk.pr);
    }
  }
  return [...prs];
}

/** The latest update, or undefined when the reader is on a first review. */
export function latestUpdate(
  document: WalkthroughDocument,
): WalkthroughUpdate | undefined {
  return document.updates.at(-1);
}

/** The chapter a step belongs to. An update item belongs to the one it touches. */
export function stepChapter(
  document: WalkthroughDocument,
  step: WalkthroughStep,
): WalkthroughChapter | undefined {
  return step.kind === "chapter"
    ? step.chapter
    : document.content.chapters.find((c) => c.id === step.item.touches);
}

/** The heading a step shows: the slot of its chapter. */
export function stepTitle(
  document: WalkthroughDocument,
  step: WalkthroughStep,
): string {
  const chapter = stepChapter(document, step);
  return chapter ? (slotLabels[chapter.slot] ?? chapter.slot) : step.key;
}

/** Steps for the full story, or only for what changed since the last visit. */
export function walkthroughSteps(
  document: WalkthroughDocument,
  mode: "story" | "update",
): WalkthroughStep[] {
  const update = latestUpdate(document);
  if (mode === "update" && update) {
    return [
      ...update.items.map((item) => ({
        kind: "item" as const,
        key: `item:${item.id}`,
        item,
        update,
      })),
      ...update.addedChapters.map((chapter) => ({
        kind: "chapter" as const,
        key: `chapter:${chapter.id}`,
        chapter,
      })),
    ];
  }
  return document.content.chapters.map((chapter) => ({
    kind: "chapter" as const,
    key: `chapter:${chapter.id}`,
    chapter,
  }));
}

/**
 * Every decision across the lineage. An update item that answers feedback
 * adds a confirm decision, so the reader closes the loop.
 */
export function reviewDecisions(
  document: WalkthroughDocument,
): ReviewDecision[] {
  const hunks = hunkIndex(document);
  const items = document.updates.flatMap((update) => update.items);
  const decisions: ReviewDecision[] = [];
  for (const chapter of document.content.chapters) {
    for (const decision of chapter.decisions) {
      const evidence =
        decision.evidence === undefined
          ? undefined
          : chapter.evidence[decision.evidence];
      decisions.push({
        id: decision.id,
        question: decision.question,
        prs: decisionPrs(document, hunks, evidence, chapter.evidence),
        stepKey: `chapter:${chapter.id}`,
        answeredBy: items.find((item) => item.answers === decision.id),
        // Feedback lands next to code. A decision about prose uses the
        // chapter's first code.
        location:
          evidenceLocation(evidence, hunks) ??
          evidenceLocation(
            chapter.evidence.find((e) => e.kind === "hunk"),
            hunks,
          ),
      });
    }
  }
  for (const item of items) {
    const prs = decisionPrs(document, hunks, undefined, item.evidence);
    const location = evidenceLocation(item.evidence[0], hunks);
    if (item.answers) {
      decisions.push({
        id: confirmDecisionId(item.id),
        question: "Does this answer your feedback?",
        context: item.caption,
        prs,
        stepKey: `item:${item.id}`,
        location,
      });
    }
    for (const decision of item.decisions) {
      decisions.push({
        id: decision.id,
        question: decision.question,
        prs,
        stepKey: `item:${item.id}`,
        location,
      });
    }
  }
  return decisions;
}

/** Id of the confirm decision that an answering update item adds. */
export function confirmDecisionId(itemId: string): string {
  return `confirm-${itemId}`;
}

export type LayerStatus =
  | { kind: "ready" }
  | { kind: "changes"; count: number }
  | { kind: "open"; count: number };

/** Decisions that still count for a layer. Answered feedback drops out. */
export function liveDecisions(
  pr: number,
  decisions: readonly ReviewDecision[],
): ReviewDecision[] {
  return decisions.filter((d) => d.prs.includes(pr) && !d.answeredBy);
}

/** A layer is ready when every live decision on it is accepted. */
export function layerStatus(
  pr: number,
  decisions: readonly ReviewDecision[],
  answers: AnswerMap,
): LayerStatus {
  const live = liveDecisions(pr, decisions);
  const changes = live.filter((d) => answers[d.id]?.value === "change").length;
  if (changes) return { kind: "changes", count: changes };
  const open = live.filter((d) => !answers[d.id]).length;
  return open ? { kind: "open", count: open } : { kind: "ready" };
}

/**
 * One layer's review as GitHub Markdown, plain enough to read before it is
 * pasted into the "Review changes" box. A permalink on its own line renders
 * as a code snippet on GitHub.
 */
export function reviewMarkdown(args: {
  answers: AnswerMap;
  comment: string;
  decisions: readonly ReviewDecision[];
  layer: WalkthroughLayer;
}): string {
  const live = liveDecisions(args.layer.pr, args.decisions);
  const changes = live.filter((d) => args.answers[d.id]?.value === "change");
  const accepted = live.filter((d) => args.answers[d.id]?.value === "accept");
  const sections: string[] = [];
  if (args.comment.trim()) sections.push(args.comment.trim());
  if (changes.length) {
    sections.push(
      [
        "**Please change**",
        ...changes.map((d, index) =>
          [
            `${index + 1}. ${d.location ? `\`${d.location.label}\`: ` : ""}${args.answers[d.id]?.note ?? d.question}`,
            args.answers[d.id]?.note ? `   > ${d.question}` : undefined,
            d.location?.url ? `\n   ${d.location.url}` : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      ].join("\n\n"),
    );
  }
  if (accepted.length) {
    sections.push(
      [
        "**Checked and fine**",
        ...accepted.map(
          (d) => `- ${d.context ? `${d.context} ` : ""}${d.question}`,
        ),
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
}

/**
 * Layers a decision blocks: its own evidence, else its chapter's code, else
 * every layer. A decision with no code still has to be answered.
 */
function decisionPrs(
  document: WalkthroughDocument,
  hunks: ReadonlyMap<string, WalkthroughHunk>,
  evidence: WalkthroughEvidence | undefined,
  chapterEvidence: readonly WalkthroughEvidence[],
): number[] {
  const own = evidence ? evidencePrs([evidence], hunks) : [];
  if (own.length) return own;
  const chapter = evidencePrs(chapterEvidence, hunks);
  return chapter.length ? chapter : document.layers.map((layer) => layer.pr);
}

function evidenceLocation(
  evidence: WalkthroughEvidence | undefined,
  hunks: ReadonlyMap<string, WalkthroughHunk>,
): ReviewDecision["location"] {
  if (evidence?.kind !== "hunk") return undefined;
  const hunk = hunks.get(evidence.hunkId);
  if (!hunk) return undefined;
  const line =
    hunk.lines.find((l) => l.kind === "add") ??
    hunk.lines.find((l) => l.kind === "remove");
  const number = line?.newLine ?? line?.oldLine;
  const file = hunk.path.split("/").at(-1) ?? hunk.path;
  return { label: number ? `${file}:${number}` : file, url: hunk.url };
}
