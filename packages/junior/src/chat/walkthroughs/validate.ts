/**
 * Checks that schema parsing cannot do. Every reference must resolve, and the
 * story must not skip risky code without saying so.
 */
import {
  WALKTHROUGH_TEMPLATES,
  type WalkthroughChapter,
  type WalkthroughEvidence,
  type WalkthroughOutput,
  type WalkthroughUpdateOutput,
} from "./schema";

/** Ids that the generation input offered to the model. */
export type WalkthroughInputRefs = {
  /** Hunks sent to the model, with their line count. Mechanical hunks are not sent. */
  hunks: ReadonlyMap<string, { lineCount: number }>;
  sourceIds: ReadonlySet<string>;
  checkIds: ReadonlySet<string>;
};

/** Parent version facts that an update may refer to. */
export type WalkthroughParentRefs = {
  chapterIds: ReadonlySet<string>;
  /** Decisions that got "change" feedback. */
  changedDecisionIds: ReadonlySet<string>;
};

/**
 * Return problems with a full generation. An empty list means the output is
 * safe to store. The generator sends the problems back to the model once.
 */
export function findWalkthroughProblems(
  output: WalkthroughOutput,
  refs: WalkthroughInputRefs,
): string[] {
  const problems: string[] = [];
  const diagramIds = new Set([
    ...output.diagram.nodes.map((node) => node.id),
    ...output.diagram.edges.map((edge) => edge.id),
  ]);
  const nodeIds = new Set(output.diagram.nodes.map((node) => node.id));
  for (const edge of output.diagram.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      problems.push(`Edge ${edge.id} joins a node that does not exist.`);
    }
  }
  problems.push(
    ...duplicateIds(
      "chapter",
      output.chapters.map((c) => c.id),
    ),
  );
  problems.push(
    ...duplicateIds(
      "decision",
      output.chapters.flatMap((c) => c.decisions.map((d) => d.id)),
    ),
  );
  for (const chapter of output.chapters) {
    problems.push(...chapterProblems(chapter, refs, diagramIds));
  }
  const bugFixCause = output.chapters.find(
    (c) => c.type === "bug_fix" && c.slot === "cause",
  );
  // The reader judges whether the cause is the root cause. They need code or
  // a check to judge it, not the model's word.
  if (bugFixCause && !bugFixCause.evidence.some((e) => e.kind !== "source")) {
    problems.push("The cause chapter cites no hunk or check.");
  }
  problems.push(
    ...coverageProblems(
      refs,
      output.chapters.flatMap((c) => c.evidence),
      output.notCovered,
    ),
  );
  return problems;
}

/** Return problems with an update. Old chapters cannot change, only be touched. */
export function findWalkthroughUpdateProblems(
  output: WalkthroughUpdateOutput,
  refs: WalkthroughInputRefs,
  parent: WalkthroughParentRefs,
): string[] {
  const problems: string[] = [];
  for (const item of output.items) {
    if (!parent.chapterIds.has(item.touches)) {
      problems.push(
        `Update item ${item.id} touches unknown chapter ${item.touches}.`,
      );
    }
    if (item.answers && !parent.changedDecisionIds.has(item.answers)) {
      problems.push(
        `Update item ${item.id} answers ${item.answers}, which has no "change" feedback.`,
      );
    }
    problems.push(
      ...item.evidence.flatMap((e) => evidenceProblems(e, refs)),
      ...citationProblems(item.id, item.body, item.evidence.length),
    );
  }
  for (const chapter of output.addedChapters) {
    if (parent.chapterIds.has(chapter.id)) {
      problems.push(`Added chapter ${chapter.id} reuses an existing id.`);
    }
    problems.push(...chapterProblems(chapter, refs, undefined));
  }
  problems.push(
    ...coverageProblems(
      refs,
      [
        ...output.items.flatMap((i) => i.evidence),
        ...output.addedChapters.flatMap((c) => c.evidence),
      ],
      output.notCovered,
    ),
  );
  return problems;
}

function chapterProblems(
  chapter: WalkthroughChapter,
  refs: WalkthroughInputRefs,
  diagramIds: ReadonlySet<string> | undefined,
): string[] {
  const problems = [
    ...chapter.evidence.flatMap((e) => evidenceProblems(e, refs)),
    ...citationProblems(chapter.id, chapter.body, chapter.evidence.length),
  ];
  const templateSlots: readonly string[] = WALKTHROUGH_TEMPLATES[chapter.type];
  if (!templateSlots.includes(chapter.slot)) {
    problems.push(
      `Chapter ${chapter.id} uses slot ${chapter.slot}, which ${chapter.type} does not have.`,
    );
  }
  for (const decision of chapter.decisions) {
    if (
      decision.evidence !== undefined &&
      decision.evidence >= chapter.evidence.length
    ) {
      problems.push(
        `Decision ${decision.id} points past the chapter evidence.`,
      );
    }
    if (
      decision.origin.kind === "assumed" &&
      !refs.sourceIds.has(decision.origin.sourceId)
    ) {
      problems.push(`Decision ${decision.id} cites unknown source.`);
    }
  }
  if (chapter.view && diagramIds) {
    const view = chapter.view;
    const ids = [
      ...view.show,
      ...view.highlight,
      ...view.added,
      ...view.broken.map((b) => b.id),
    ];
    for (const id of ids) {
      if (!diagramIds.has(id)) {
        problems.push(`Chapter ${chapter.id} shows unknown diagram id ${id}.`);
      }
    }
  }
  return problems;
}

/**
 * The prose cites evidence as "[n]". Each citation must resolve, and each
 * piece of evidence must be cited, so no reference floats free of the story.
 */
function citationProblems(
  id: string,
  body: string,
  evidenceCount: number,
): string[] {
  const cited = new Set(
    [...body.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])),
  );
  const problems = [...cited]
    .filter((n) => n < 1 || n > evidenceCount)
    .map((n) => `${id} cites [${n}], which is not in its evidence.`);
  for (let n = 1; n <= evidenceCount; n++) {
    if (!cited.has(n)) problems.push(`${id} never cites evidence [${n}].`);
  }
  return problems;
}

function evidenceProblems(
  evidence: WalkthroughEvidence,
  refs: WalkthroughInputRefs,
): string[] {
  if (evidence.kind === "source") {
    return refs.sourceIds.has(evidence.sourceId)
      ? []
      : [`Unknown source ${evidence.sourceId}.`];
  }
  if (evidence.kind === "check") {
    return refs.checkIds.has(evidence.checkId)
      ? []
      : [`Unknown check ${evidence.checkId}.`];
  }
  const hunk = refs.hunks.get(evidence.hunkId);
  if (!hunk) return [`Unknown hunk ${evidence.hunkId}.`];
  if (
    evidence.lines &&
    (evidence.lines.start > evidence.lines.end ||
      evidence.lines.end > hunk.lineCount)
  ) {
    return [`Lines for hunk ${evidence.hunkId} are out of range.`];
  }
  return [];
}

/** Every hunk sent to the model is cited or listed as not covered. */
function coverageProblems(
  refs: WalkthroughInputRefs,
  evidence: readonly WalkthroughEvidence[],
  notCovered: readonly { hunkId: string }[],
): string[] {
  const seen = new Set<string>();
  for (const e of evidence) if (e.kind === "hunk") seen.add(e.hunkId);
  for (const n of notCovered) seen.add(n.hunkId);
  return [...refs.hunks.keys()]
    .filter((id) => !seen.has(id))
    .map((id) => `Hunk ${id} is not cited and not in notCovered.`);
}

function duplicateIds(kind: string, ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) problems.push(`Duplicate ${kind} id ${id}.`);
    seen.add(id);
  }
  return problems;
}
