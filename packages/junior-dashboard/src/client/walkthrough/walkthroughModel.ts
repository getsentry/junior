import type {
  WalkthroughAnswer,
  WalkthroughChapter,
  WalkthroughDocument,
  WalkthroughEvidence,
  WalkthroughHunk,
} from "@sentry/junior/api/schema";

export type WalkthroughUpdate = WalkthroughDocument["updates"][number];
export type WalkthroughUpdateItem = WalkthroughUpdate["items"][number];

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
  /** Update item that answers earlier "change" feedback on this decision. */
  answeredBy?: WalkthroughUpdateItem;
  location?: string;
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
  proof: "Proof",
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
  how_well_know: "How we'll know",
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
        prs: evidencePrs(evidence ? [evidence] : chapter.evidence, hunks),
        answeredBy: items.find((item) => item.answers === decision.id),
        location: evidenceLocation(evidence, hunks),
      });
    }
  }
  for (const item of items) {
    const prs = evidencePrs(item.evidence, hunks);
    if (item.answers) {
      decisions.push({
        id: confirmDecisionId(item.id),
        question: "Does this answer your feedback?",
        prs,
        location: evidenceLocation(item.evidence[0], hunks),
      });
    }
    for (const decision of item.decisions) {
      decisions.push({
        id: decision.id,
        question: decision.question,
        prs,
        location: evidenceLocation(item.evidence[0], hunks),
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

/** A layer is ready when every live decision on it is accepted. */
export function layerStatus(
  pr: number,
  decisions: readonly ReviewDecision[],
  answers: AnswerMap,
): LayerStatus {
  const live = decisions.filter(
    (decision) => decision.prs.includes(pr) && !decision.answeredBy,
  );
  const changes = live.filter((d) => answers[d.id]?.value === "change").length;
  if (changes) return { kind: "changes", count: changes };
  const open = live.filter((d) => !answers[d.id]).length;
  return open ? { kind: "open", count: open } : { kind: "ready" };
}

/** Feedback that is still open, as Markdown for a GitHub review. */
export function feedbackMarkdown(
  decisions: readonly ReviewDecision[],
  answers: AnswerMap,
): string {
  return openFeedback(decisions, answers)
    .map(({ decision, note }) => {
      const where = [
        decision.prs.map((pr) => `#${pr}`).join(", "),
        decision.location,
      ]
        .filter(Boolean)
        .join(" · ");
      return [
        `**${where}**`,
        `> ${decision.question}`,
        "",
        note || "Please change this.",
      ].join("\n");
    })
    .join("\n\n");
}

/** "Change" answers that no update item has answered yet. */
export function openFeedback(
  decisions: readonly ReviewDecision[],
  answers: AnswerMap,
): { decision: ReviewDecision; note?: string }[] {
  return decisions
    .filter((d) => answers[d.id]?.value === "change" && !d.answeredBy)
    .map((decision) => ({ decision, note: answers[decision.id]?.note }));
}

function evidenceLocation(
  evidence: WalkthroughEvidence | undefined,
  hunks: ReadonlyMap<string, WalkthroughHunk>,
): string | undefined {
  if (evidence?.kind !== "hunk") return undefined;
  const hunk = hunks.get(evidence.hunkId);
  if (!hunk) return undefined;
  const line = hunk.lines.find((l) => l.kind !== "context");
  const number = line?.newLine ?? line?.oldLine;
  const file = hunk.path.split("/").at(-1);
  return number ? `${file}:${number}` : file;
}
