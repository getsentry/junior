import type {
  WalkthroughChapter,
  WalkthroughDocument,
  WalkthroughUpdate,
} from "@sentry/junior/api/schema";

import type { AnswerMap } from "./walkthroughModel";

/** One update item, with the update that added it. */
export type ChapterChange = {
  item: WalkthroughUpdate["items"][number];
  /** 1-based place of the update in the lineage. The story is 0. */
  update: number;
  /** The update came after the reviewer last looked. */
  unseen: boolean;
};

/** Every chapter in reading order: the story, then chapters updates added. */
export function walkthroughChapters(
  document: WalkthroughDocument,
): WalkthroughChapter[] {
  return [
    ...document.content.chapters,
    ...document.updates.flatMap((update) => update.added_chapters),
  ];
}

/**
 * Where a version sits in the lineage: the story is 0 and each update adds
 * one. An answer from an unknown version counts as the oldest.
 */
function versionRank(document: WalkthroughDocument, versionId: string) {
  const index = document.updates.findIndex((u) => u.versionId === versionId);
  return index + 1;
}

/**
 * The last version the reviewer answered on before this one. Updates after
 * it are new to them. A reviewer who never answered sees every update.
 */
export function lastSeenRank(
  document: WalkthroughDocument,
  answers: AnswerMap,
): number {
  let seen = 0;
  for (const answer of Object.values(answers)) {
    if (answer.versionId === document.versionId) continue;
    seen = Math.max(seen, versionRank(document, answer.versionId));
  }
  return seen;
}

/** Update items by the chapter they touch, oldest first. */
export function chapterChanges(
  document: WalkthroughDocument,
  seen: number,
): Map<string, ChapterChange[]> {
  const changes = new Map<string, ChapterChange[]>();
  document.updates.forEach((update, index) => {
    for (const item of update.items) {
      const list = changes.get(item.touches) ?? [];
      list.push({ item, update: index + 1, unseen: index + 1 > seen });
      changes.set(item.touches, list);
    }
  });
  return changes;
}

/** Chapters that updates added, by id, with the update that added them. */
export function addedChapterRanks(
  document: WalkthroughDocument,
): Map<string, number> {
  return new Map(
    document.updates.flatMap((update, index) =>
      update.added_chapters.map((chapter) => [chapter.id, index + 1] as const),
    ),
  );
}

/**
 * What an answer means on this version. An answer holds while the code its
 * chapter cites stays the same. When a later update changed that code, the
 * decision reopens and the old answer is only shown for context.
 */
export function answerState(
  document: WalkthroughDocument,
  chapterId: string,
  answer: AnswerMap[string] | undefined,
): "current" | "reopened" | undefined {
  if (!answer) return undefined;
  const rank = versionRank(document, answer.versionId);
  const reopened = document.updates.some(
    (update, index) =>
      index + 1 > rank && update.changedChapters.includes(chapterId),
  );
  return reopened ? "reopened" : "current";
}

/** The update item that answers a reviewer's change request, if any. */
export function feedbackItem(
  document: WalkthroughDocument,
  decisionId: string,
  answer: AnswerMap[string] | undefined,
): WalkthroughUpdate["items"][number] | undefined {
  if (answer?.value !== "change") return undefined;
  const rank = versionRank(document, answer.versionId);
  for (let index = document.updates.length - 1; index >= rank; index--) {
    const item = document.updates[index]?.items.find(
      (i) => i.answers === decisionId,
    );
    if (item) return item;
  }
  return undefined;
}

/** What the "What changed" section lists for updates the reviewer has not seen. */
export type WalkthroughChangeSummary = {
  movedLayers: number[];
  newLayers: number[];
  leftLayers: WalkthroughUpdate["leftLayers"];
  /** Changed or added chapters, in reading order, with their index. */
  chapters: { index: number; added: boolean; captions: string[] }[];
};

/** Sum the updates after `seen`. Undefined when there are none. */
export function changeSummary(
  document: WalkthroughDocument,
  seen: number,
): WalkthroughChangeSummary | undefined {
  const unseen = document.updates.slice(seen);
  if (unseen.length === 0) return undefined;
  const unique = (values: number[]) => [...new Set(values)];
  const changes = chapterChanges(document, seen);
  const added = addedChapterRanks(document);
  const chapters = walkthroughChapters(document).flatMap((chapter, index) => {
    const items = (changes.get(chapter.id) ?? []).filter((c) => c.unseen);
    const isNew = (added.get(chapter.id) ?? 0) > seen;
    if (!items.length && !isNew) return [];
    return [
      {
        index,
        added: isNew,
        captions: isNew
          ? [chapter.caption]
          : items.map((change) => change.item.caption),
      },
    ];
  });
  return {
    movedLayers: unique(unseen.flatMap((u) => u.movedLayers)),
    newLayers: unique(unseen.flatMap((u) => u.newLayers)),
    leftLayers: unseen.flatMap((u) => u.leftLayers),
    chapters,
  };
}
