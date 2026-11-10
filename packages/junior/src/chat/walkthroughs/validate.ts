/**
 * Checks that schema parsing cannot do. Every reference must resolve, and the
 * story must not skip risky code without saying so.
 */
import {
  WALKTHROUGH_TEMPLATES,
  type WalkthroughChapter,
  type WalkthroughCodeRef,
  type WalkthroughEvidence,
  type WalkthroughOutput,
  type WalkthroughUpdateOutput,
} from "./schema";

/** Inclusive line range on one side of a diff hunk. */
export type WalkthroughLineRange = { start: number; end: number };

/**
 * One diff hunk. A side is missing when the hunk has no lines there, such as
 * the base side of a new file.
 */
export type WalkthroughHunkRange = {
  head?: WalkthroughLineRange;
  base?: WalkthroughLineRange;
};

/** One changed file in one PR, with its hunks. */
export type WalkthroughDiffFile = {
  pr: number;
  path: string;
  hunks: readonly WalkthroughHunkRange[];
};

/** What the generation input offered to the model. */
export type WalkthroughInputRefs = {
  /** Mechanical files are left out, so they cannot be cited and need no coverage. */
  files: readonly WalkthroughDiffFile[];
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
    problems.push("The cause chapter cites no code or check.");
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
  return codeProblems(evidence, refs);
}

function codeProblems(
  ref: WalkthroughCodeRef,
  refs: WalkthroughInputRefs,
): string[] {
  const label = `${ref.path} lines ${ref.start}-${ref.end} (${ref.side}) in PR #${ref.pr}`;
  if (ref.start > ref.end) return [`${label}: start is after end.`];
  const file = refs.files.find((f) => f.pr === ref.pr && f.path === ref.path);
  if (!file) return [`${label}: the file is not in the PR diff.`];
  const inside = file.hunks.some((hunk) => {
    const range = hunk[ref.side];
    return range && ref.start >= range.start && ref.end <= range.end;
  });
  return inside ? [] : [`${label}: the range is not inside one diff hunk.`];
}

/**
 * Every hunk sent to the model overlaps a code citation, or its file is listed
 * as not covered.
 */
function coverageProblems(
  refs: WalkthroughInputRefs,
  evidence: readonly WalkthroughEvidence[],
  notCovered: readonly { pr: number; path: string }[],
): string[] {
  const excused = (file: WalkthroughDiffFile) =>
    notCovered.some((n) => n.pr === file.pr && n.path === file.path);
  const cited = evidence.filter((e) => e.kind === "code");
  const problems: string[] = [];
  for (const file of refs.files) {
    if (excused(file)) continue;
    const citations = cited.filter(
      (e) => e.pr === file.pr && e.path === file.path,
    );
    for (const hunk of file.hunks) {
      const covered = citations.some((e) => {
        const range = hunk[e.side];
        return range && e.start <= range.end && e.end >= range.start;
      });
      const side = hunk.head ? "head" : "base";
      const range = hunk[side];
      if (covered || !range) continue;
      problems.push(
        `${file.path} lines ${range.start}-${range.end} (${side}) in PR #${file.pr} are not cited, and the file is not in notCovered.`,
      );
    }
  }
  return problems;
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
