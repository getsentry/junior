import {
  codeExcerptId,
  type WalkthroughChapter,
  type WalkthroughDocument,
  type WalkthroughEvidence,
  type WalkthroughExcerpt,
  type WalkthroughVersionResponse,
} from "@sentry/junior/api/schema";

type Check = WalkthroughDocument["checks"][number];
type Message = WalkthroughDocument["messages"][number];

/** The chapter heading for each slot. The model fills slots; it never names them. */
const slotLabels: Record<string, string> = {
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

/** The heading of one chapter. */
export function chapterTitle(chapter: WalkthroughChapter): string {
  return slotLabels[chapter.slot] ?? chapter.slot;
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
export function evidencePrs(
  evidence: readonly WalkthroughEvidence[],
): number[] {
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
