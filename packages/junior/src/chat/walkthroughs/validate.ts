/**
 * Checks that schema parsing cannot do. Every reference must resolve, and the
 * story must not skip risky code without saying so.
 */
import {
  WALKTHROUGH_TEMPLATES,
  type WalkthroughChapter,
  type WalkthroughCodeRef,
  type WalkthroughDecision,
  type WalkthroughDiagram,
  type WalkthroughEvidence,
  type WalkthroughOutput,
  type WalkthroughUpdateOutput,
} from "./schema";
import type { WalkthroughDiffFile } from "./diff";

/** What a Walkthrough may cite, as read from the provider and the source Conversation. */
export type WalkthroughInputRefs = {
  /** Numbers of the code changes in the stack. */
  prs: ReadonlySet<number>;
  /** Mechanical files are left out, so they cannot be cited and need no coverage. */
  files: readonly WalkthroughDiffFile[];
  /**
   * Text of files read at a PR head commit, keyed by `contextFileKey`.
   * Head-side citations outside the diff must land in one of these.
   */
  contextFiles: ReadonlyMap<string, string>;
  /** Seqs of messages that exist in the source Conversation. */
  messageSeqs: ReadonlySet<number>;
  /** URLs that appear in a PR body or a cited message. */
  knownUrls: ReadonlySet<string>;
  checkIds: ReadonlySet<string>;
};

/** Key of a file read at the head commit of one PR. */
export function contextFileKey(pr: number, path: string): string {
  return `${pr}:${path}`;
}

/** Node and edge ids of each diagram, by code change. */
export type DiagramIds = ReadonlyMap<number, ReadonlySet<string>>;

/** Collect the ids that chapter views may show, by code change. */
export function walkthroughDiagramIds(
  diagrams: readonly WalkthroughDiagram[],
): DiagramIds {
  return new Map(
    diagrams.map((diagram) => [
      diagram.pr,
      new Set([
        ...diagram.nodes.map((node) => node.id),
        ...diagram.edges.map((edge) => edge.id),
      ]),
    ]),
  );
}

/** Previous version facts that an update may refer to. */
export type WalkthroughParentRefs = {
  chapterIds: ReadonlySet<string>;
  /** Chapters whose cited code changed. Each needs an update item. */
  changedChapterIds: ReadonlySet<string>;
  /** Decision and earlier update item ids. New ids must not reuse them. */
  decisionIds: ReadonlySet<string>;
  /** Decisions that got "change" feedback. */
  changedDecisionIds: ReadonlySet<string>;
  /** Node and edge ids of each diagram, by code change. */
  diagrams: DiagramIds;
  /** `contextFileKey` of files whose diff changed. Only these need coverage. */
  changedFiles: ReadonlySet<string>;
};

/**
 * Return problems with a full generation. An empty list means the output is
 * safe to store. Otherwise the problems go back to the model to fix.
 */
export function validateWalkthrough(
  output: WalkthroughOutput,
  refs: WalkthroughInputRefs,
): string[] {
  const problems: string[] = [...diagramProblems(output.diagrams, refs)];
  const diagrams = walkthroughDiagramIds(output.diagrams);
  problems.push(
    ...duplicateIds(
      "chapter",
      output.chapters.map((c) => c.id),
    ),
  );
  // The caption is the chapter title, and a slot such as "The change"
  // repeats, so only the caption tells chapters apart.
  const captions = new Map<string, string>();
  for (const chapter of output.chapters) {
    const key = chapter.caption.trim().toLowerCase();
    const first = captions.get(key);
    if (first) {
      problems.push(
        `Chapters ${first} and ${chapter.id} have the same caption. Make each caption unique.`,
      );
    } else {
      captions.set(key, chapter.id);
    }
  }
  problems.push(
    ...duplicateIds(
      "decision",
      output.chapters.flatMap((c) => c.decisions.map((d) => d.id)),
    ),
  );
  for (const chapter of output.chapters) {
    problems.push(...chapterProblems(chapter, refs, diagrams));
  }
  problems.push(...repeatedViewProblems(output.chapters));
  const bugFixCause = output.chapters.find(
    (c) => c.type === "bug_fix" && c.slot === "cause",
  );
  // The reader judges whether the cause is the root cause. They need code or
  // a check to judge it, not the model's word.
  if (
    bugFixCause &&
    !bugFixCause.evidence.some((e) => e.kind === "code" || e.kind === "check")
  ) {
    problems.push("The cause chapter cites no code or check.");
  }
  problems.push(
    ...coverageProblems(
      refs,
      output.chapters.flatMap((c) => c.evidence),
      output.not_covered,
    ),
  );
  return problems;
}

/**
 * Return problems with an update. Old chapters cannot change, only be
 * touched, and only the code that changed since the previous version needs
 * coverage.
 */
export function validateWalkthroughUpdate(
  output: WalkthroughUpdateOutput,
  refs: WalkthroughInputRefs,
  parent: WalkthroughParentRefs,
): string[] {
  const problems: string[] = [];
  const newIds = [
    ...output.items.flatMap((i) => [i.id, ...i.decisions.map((d) => d.id)]),
    ...output.added_chapters.flatMap((c) => c.decisions.map((d) => d.id)),
  ];
  problems.push(...duplicateIds("decision or item", newIds));
  for (const id of newIds) {
    if (parent.decisionIds.has(id)) {
      problems.push(`Id ${id} is already used by the previous version.`);
    }
  }
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
      ...item.decisions.flatMap(claimProblems),
    );
  }
  const touched = new Set(output.items.map((item) => item.touches));
  for (const id of parent.changedChapterIds) {
    if (!touched.has(id)) {
      problems.push(
        `The code that chapter ${id} cites changed, but no update item touches it.`,
      );
    }
  }
  for (const chapter of output.added_chapters) {
    if (parent.chapterIds.has(chapter.id)) {
      problems.push(`Added chapter ${chapter.id} reuses an existing id.`);
    }
    problems.push(...chapterProblems(chapter, refs, parent.diagrams));
  }
  problems.push(
    ...coverageProblems(
      {
        ...refs,
        files: refs.files.filter((file) =>
          parent.changedFiles.has(contextFileKey(file.pr, file.path)),
        ),
      },
      [
        ...output.items.flatMap((i) => i.evidence),
        ...output.added_chapters.flatMap((c) => c.evidence),
      ],
      output.not_covered,
    ),
  );
  return problems;
}

/** Each diagram belongs to one code change, and its edges join its nodes. */
function diagramProblems(
  diagrams: readonly WalkthroughDiagram[],
  refs: WalkthroughInputRefs,
): string[] {
  const problems: string[] = [];
  const seen = new Set<number>();
  for (const diagram of diagrams) {
    if (!refs.prs.has(diagram.pr)) {
      problems.push(
        `A diagram is for PR #${diagram.pr}, which is not in the stack.`,
      );
    }
    if (seen.has(diagram.pr)) {
      problems.push(
        `PR #${diagram.pr} has more than one diagram. Use one per PR.`,
      );
    }
    seen.add(diagram.pr);
    const nodeIds = new Set(diagram.nodes.map((node) => node.id));
    for (const edge of diagram.edges) {
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        problems.push(
          `Edge ${edge.id} in the diagram for PR #${diagram.pr} joins a node that is not in that diagram.`,
        );
      }
    }
  }
  return problems;
}

/**
 * A reviewer agrees with a decision or asks to change it, so it must be a
 * claim. A question reads oddly under "Agreed" in the copied review.
 */
function claimProblems(decision: WalkthroughDecision): string[] {
  return decision.claim.trim().endsWith("?")
    ? [
        `Decision ${decision.id} is a question. Write the claim as a statement, and put the doubt in concern.`,
      ]
    : [];
}

function chapterProblems(
  chapter: WalkthroughChapter,
  refs: WalkthroughInputRefs,
  diagrams: DiagramIds,
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
    problems.push(...claimProblems(decision));
    if (
      decision.evidence !== undefined &&
      decision.evidence >= chapter.evidence.length
    ) {
      problems.push(
        `Decision ${decision.id} points past the chapter evidence.`,
      );
    }
  }
  if (chapter.view) {
    const view = chapter.view;
    const diagramIds = diagrams.get(view.pr);
    if (!diagramIds) {
      return [
        ...problems,
        `Chapter ${chapter.id} shows the diagram for PR #${view.pr}, which has none.`,
      ];
    }
    const ids = [
      ...view.show,
      ...view.highlight,
      ...view.added,
      ...view.broken.map((b) => b.id),
    ];
    for (const id of ids) {
      if (!diagramIds.has(id)) {
        problems.push(
          `Chapter ${chapter.id} shows ${id}, which is not in the diagram for PR #${view.pr}.`,
        );
      }
    }
  }
  return problems;
}

/**
 * A diagram shows where its code change comes in. A later chapter shows it
 * again only to bring in a part the reader has not seen, or to mark a broken
 * part. Otherwise every chapter repeats a picture the reader already has.
 */
function repeatedViewProblems(
  chapters: readonly WalkthroughChapter[],
): string[] {
  const seen = new Map<number, Set<string>>();
  const problems: string[] = [];
  for (const chapter of chapters) {
    const view = chapter.view;
    if (!view) continue;
    const shown = seen.get(view.pr);
    const ids = [...view.show, ...view.added];
    if (shown && view.broken.length === 0 && ids.every((id) => shown.has(id))) {
      problems.push(
        `Chapter ${chapter.id} shows only parts of the PR #${view.pr} diagram that an earlier chapter showed. Remove its view, or show a part the reader has not seen.`,
      );
    }
    seen.set(view.pr, new Set([...(shown ?? []), ...ids]));
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
  if (evidence.kind === "message") {
    return refs.messageSeqs.has(evidence.seq)
      ? []
      : [`Message ${evidence.seq} is not in the source Conversation.`];
  }
  if (evidence.kind === "link") {
    return refs.knownUrls.has(evidence.url)
      ? []
      : [`Link ${evidence.url} is not in a PR body or a cited message.`];
  }
  if (evidence.kind === "check") {
    return refs.checkIds.has(evidence.check_id)
      ? []
      : [`Unknown check ${evidence.check_id}.`];
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
  const inHunk = file?.hunks.some((hunk) => {
    const range = hunk[ref.side];
    return range && ref.start >= range.start && ref.end <= range.end;
  });
  if (inHunk) return [];
  if (ref.side === "base") {
    return [`${label}: base-side ranges must be inside one diff hunk.`];
  }
  const text = refs.contextFiles.get(contextFileKey(ref.pr, ref.path));
  if (text === undefined) {
    return [`${label}: the file does not exist at the PR head commit.`];
  }
  const lines = text.replace(/\n$/, "").split("\n").length;
  return ref.end <= lines
    ? []
    : [`${label}: the file has only ${lines} lines at the PR head commit.`];
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
        `${file.path} lines ${range.start}-${range.end} (${side}) in PR #${file.pr} are not cited, and the file is not in not_covered.`,
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
