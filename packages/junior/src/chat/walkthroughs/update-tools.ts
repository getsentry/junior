/**
 * The tools of a Walkthrough update Turn. An update builds on the previous
 * version, like a forward migration: it reads that version and what changed
 * since, then adds update items. It never rewrites the story.
 */
import * as z from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { readChangeRequestedDecisionIds } from "./answers";
import { buildWalkthroughExcerpts } from "./excerpts";
import {
  walkthroughUpdateOutputSchema,
  type WalkthroughDocument,
} from "./schema";
import {
  getWalkthroughVersion,
  readWalkthroughAncestorIds,
  readWalkthroughDocument,
} from "./store";
import {
  codeCitations,
  documentLayers,
  inputRefs,
  linkedExcerpts,
  readCitedMessages,
  readContextFiles,
  storeWalkthrough,
  SUBMIT_WALKTHROUGH_TOOL_NAME,
  WALKTHROUGH_PROMPT_VERSION,
  type WalkthroughGeneration,
  type WalkthroughReads,
} from "./submit-tool";
import {
  compareWalkthroughStack,
  walkthroughChapters,
  walkthroughDecisionIds,
  walkthroughFileHashes,
  type WalkthroughStackChanges,
} from "./update";
import { validateWalkthroughUpdate } from "./validate";

export const READ_PREVIOUS_WALKTHROUGH_TOOL_NAME = "readPreviousWalkthrough";

type UpdateBase = {
  previous: WalkthroughDocument;
  changes: WalkthroughStackChanges;
  /** Decisions that a reviewer asked to change. */
  feedback: string[];
};

/**
 * Create the tools of one update Turn: `readPreviousWalkthrough` and the
 * update form of `submitWalkthrough`.
 */
export function createWalkthroughUpdateTools(
  context: ToolRuntimeContext,
  generation: WalkthroughGeneration & { parentVersionId: string },
  reads: WalkthroughReads,
) {
  let base: Promise<UpdateBase> | undefined;
  const loadBase = () =>
    (base ??= (async () => {
      if (!context.attachmentStorage) {
        throw new Error("Walkthrough generation needs attachment storage");
      }
      const parent = await getWalkthroughVersion(generation.parentVersionId);
      const previous =
        parent &&
        (await readWalkthroughDocument(context.attachmentStorage, parent));
      if (!previous) {
        throw new Error(
          `Walkthrough version ${generation.parentVersionId} has no stored document`,
        );
      }
      const [{ files }, ancestors] = await Promise.all([
        reads.loadDiff(),
        readWalkthroughAncestorIds(generation.parentVersionId),
      ]);
      return {
        previous,
        changes: compareWalkthroughStack(previous, generation.layers, files),
        feedback: await readChangeRequestedDecisionIds(ancestors),
      };
    })());

  return {
    [READ_PREVIOUS_WALKTHROUGH_TOOL_NAME]: zodTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Read the previous version that this update builds on, and what changed since: the files whose diff changed, the chapters that cite them, layers that joined or left the stack, and decisions that a reviewer asked to change.",
      exposure: "modelOnly",
      inputSchema: z.object({}).strict(),
      outputSchema: juniorToolOutputSchema.extend({
        previous: z.object({
          code_changes: z.array(z.unknown()),
          story: z.unknown(),
          updates: z.array(z.unknown()),
        }),
        changed_files: z.array(z.object({ pr: z.number(), path: z.string() })),
        changed_chapters: z.array(z.string()),
        new_layers: z.array(z.number()),
        left_layers: z.array(z.number()),
        feedback_decisions: z.array(z.string()),
      }),
      execute: async () => {
        const { previous, changes, feedback } = await loadBase();
        return {
          previous: {
            code_changes: previous.layers.map((layer) => ({
              pr: layer.pr,
              title: layer.title,
              base_sha: layer.baseSha,
              head_sha: layer.headSha,
            })),
            story: previous.content,
            updates: previous.updates.map((update) => ({
              items: update.items,
              added_chapters: update.added_chapters,
            })),
          },
          changed_files: [...changes.changedFiles].map((key) => {
            const split = key.indexOf(":");
            return {
              pr: Number(key.slice(0, split)),
              path: key.slice(split + 1),
            };
          }),
          changed_chapters: changes.changedChapters,
          new_layers: changes.newLayers,
          left_layers: changes.leftLayers.map((layer) => layer.pr),
          feedback_decisions: feedback,
        };
      },
    }),
    [SUBMIT_WALKTHROUGH_TOOL_NAME]: zodTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Submit the update for this generation Turn. The runtime checks every citation, that each changed chapter has an update item, and that the changed code is covered. When it reports problems, fix them and call this again.",
      exposure: "modelOnly",
      inputSchema: walkthroughUpdateOutputSchema,
      outputSchema: juniorToolOutputSchema.extend({
        version_id: z.string(),
        excerpts: z.number().int().nonnegative(),
      }),
      execute: async (output) => {
        const { previous, changes, feedback } = await loadBase();
        const evidence = [
          ...output.items.flatMap((item) => item.evidence),
          ...output.added_chapters.flatMap((chapter) => chapter.evidence),
        ];
        const codeRefs = codeCitations(evidence);
        const [{ files, skipped }, contextFiles, cited] = await Promise.all([
          reads.loadDiff(),
          readContextFiles(codeRefs, reads.loadHeadFile),
          readCitedMessages(context, generation, evidence),
        ]);
        const messages = [
          ...previous.messages.filter(
            (message) => !cited.some((m) => m.seq === message.seq),
          ),
          ...cited,
        ].sort((a, b) => a.seq - b.seq);
        const problems = validateWalkthroughUpdate(
          output,
          inputRefs(generation, files, contextFiles, messages),
          {
            chapterIds: new Set(walkthroughChapters(previous).map((c) => c.id)),
            changedChapterIds: new Set(changes.changedChapters),
            decisionIds: walkthroughDecisionIds(previous),
            changedDecisionIds: new Set(feedback),
            diagramIds: new Set([
              ...previous.content.diagram.nodes.map((node) => node.id),
              ...previous.content.diagram.edges.map((edge) => edge.id),
            ]),
            changedFiles: changes.changedFiles,
          },
        );
        if (problems.length > 0) {
          throw new ToolInputError(
            `The update has ${problems.length} problem(s). Fix them and call ${SUBMIT_WALKTHROUGH_TOOL_NAME} again:\n${problems.map((p) => `- ${p}`).join("\n")}`,
          );
        }
        const excerpts = linkedExcerpts(
          generation,
          buildWalkthroughExcerpts(codeRefs, files, contextFiles),
        );
        // A new excerpt replaces an old one with the same id: the same range
        // of the same file now shows its code at the new commits.
        const fresh = new Set(excerpts.map((excerpt) => excerpt.id));
        const createdAt = new Date().toISOString();
        const document: WalkthroughDocument = {
          ...previous,
          versionId: generation.versionId,
          parentVersionId: generation.parentVersionId,
          layers: documentLayers(generation),
          excerpts: [
            ...previous.excerpts.filter((excerpt) => !fresh.has(excerpt.id)),
            ...excerpts,
          ],
          files: walkthroughFileHashes(files),
          skipped,
          messages,
          updates: [
            ...previous.updates,
            {
              ...output,
              versionId: generation.versionId,
              createdAt,
              changedChapters: changes.changedChapters,
              movedLayers: changes.movedLayers,
              newLayers: changes.newLayers,
              leftLayers: changes.leftLayers,
            },
          ],
          meta: {
            modelId: generation.modelId,
            promptVersion: WALKTHROUGH_PROMPT_VERSION,
            createdAt,
          },
        };
        await storeWalkthrough(context, document);
        return { version_id: generation.versionId, excerpts: excerpts.length };
      },
    }),
  };
}
