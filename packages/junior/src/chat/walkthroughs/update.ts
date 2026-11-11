/**
 * What changed between a Walkthrough version and the stack it updates to.
 *
 * Junior decides this, not the model. A file changed when the lines its diff
 * adds or removes changed, so a rebase that only moves context changes
 * nothing. A chapter changed when it cites code in a changed file, and its
 * decisions reopen.
 */
import { createHash } from "node:crypto";
import type { WalkthroughCodeChange } from "@/db/schema/walkthroughs";
import type { WalkthroughDiffFile } from "./diff";
import type {
  WalkthroughChapter,
  WalkthroughDocument,
  WalkthroughEvidence,
} from "./schema";
import { contextFileKey } from "./validate";

/** How the stack moved since the previous version. */
export type WalkthroughStackChanges = {
  /** `contextFileKey` of files whose diff changed, joined, or left. */
  changedFiles: Set<string>;
  changedChapters: string[];
  movedLayers: number[];
  newLayers: number[];
  leftLayers: WalkthroughDocument["updates"][number]["leftLayers"];
};

/** Fingerprint each file by the lines its diff adds and removes. */
export function walkthroughFileHashes(
  files: readonly WalkthroughDiffFile[],
): WalkthroughDocument["files"] {
  return files.map((file) => {
    const hash = createHash("sha256");
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind !== "context")
          hash.update(`${line.kind}:${line.content}\n`);
      }
    }
    return { pr: file.pr, path: file.path, hash: hash.digest("hex") };
  });
}

/** Every chapter of a version: the story, then chapters that updates added. */
export function walkthroughChapters(
  document: WalkthroughDocument,
): WalkthroughChapter[] {
  return [
    ...document.content.chapters,
    ...document.updates.flatMap((update) => update.added_chapters),
  ];
}

/** A chapter's evidence, with the update items that touched it. */
function chapterEvidence(
  document: WalkthroughDocument,
  chapter: WalkthroughChapter,
): WalkthroughEvidence[] {
  return [
    ...chapter.evidence,
    ...document.updates.flatMap((update) =>
      update.items
        .filter((item) => item.touches === chapter.id)
        .flatMap((item) => item.evidence),
    ),
  ];
}

/** Compare a previous version with the stack at its new commits. */
export function compareWalkthroughStack(
  previous: WalkthroughDocument,
  layers: readonly WalkthroughCodeChange[],
  files: readonly WalkthroughDiffFile[],
): WalkthroughStackChanges {
  const before = new Map(
    previous.files.map((file) => [
      contextFileKey(file.pr, file.path),
      file.hash,
    ]),
  );
  const after = new Map(
    walkthroughFileHashes(files).map((file) => [
      contextFileKey(file.pr, file.path),
      file.hash,
    ]),
  );
  const current = new Set(layers.map((layer) => layer.number));
  const changedFiles = new Set<string>();
  for (const [key, hash] of after) {
    if (before.get(key) !== hash) changedFiles.add(key);
  }
  // A file that left the diff of a layer still in the stack changed too.
  for (const file of previous.files) {
    const key = contextFileKey(file.pr, file.path);
    if (current.has(file.pr) && !after.has(key)) changedFiles.add(key);
  }
  const previousLayers = new Map(previous.layers.map((l) => [l.pr, l]));
  return {
    changedFiles,
    changedChapters: walkthroughChapters(previous)
      .filter((chapter) =>
        chapterEvidence(previous, chapter).some(
          (e) =>
            e.kind === "code" && changedFiles.has(contextFileKey(e.pr, e.path)),
        ),
      )
      .map((chapter) => chapter.id),
    movedLayers: layers
      .filter((layer) => {
        const old = previousLayers.get(layer.number);
        return old && old.headSha !== layer.headSha;
      })
      .map((layer) => layer.number),
    newLayers: layers
      .filter((layer) => !previousLayers.has(layer.number))
      .map((layer) => layer.number),
    leftLayers: previous.layers
      .filter((layer) => !current.has(layer.pr))
      .map(({ pr, title, url }) => ({ pr, title, url })),
  };
}

/** Ids an update must not reuse: decisions and earlier update items. */
export function walkthroughDecisionIds(
  document: WalkthroughDocument,
): Set<string> {
  return new Set([
    ...walkthroughChapters(document).flatMap((c) =>
      c.decisions.map((d) => d.id),
    ),
    ...document.updates.flatMap((update) =>
      update.items.flatMap((item) => [
        item.id,
        ...item.decisions.map((d) => d.id),
      ]),
    ),
  ]);
}
