/**
 * The tool that ends a Walkthrough generation Turn. The model explores in
 * its sandbox, which is not trusted, then submits structured output here.
 * This tool re-reads every cited fact from the provider and the source
 * Conversation, so a stored Walkthrough only cites what really exists.
 */
import * as z from "zod";
import { assertCanReadConversationEvents } from "@/chat/conversations/event-access";
import { getConversationEventStore } from "@/chat/db";
import {
  readPluginCodeChangeDiff,
  readPluginCodeFile,
} from "@/chat/plugins/code-change-hooks";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { readWalkthroughDiff, type WalkthroughDiffFile } from "./diff";
import { buildWalkthroughExcerpts } from "./excerpts";
import {
  WALKTHROUGH_SCHEMA_VERSION,
  walkthroughOutputSchema,
  type WalkthroughDocument,
  type WalkthroughOutput,
} from "./schema";
import { completeWalkthroughVersion } from "./store";
import { contextFileKey, validateWalkthrough } from "./validate";

export const SUBMIT_WALKTHROUGH_TOOL_NAME = "submitWalkthrough";
/** Bump when the skill or tool contract changes what the model writes. */
const WALKTHROUGH_PROMPT_VERSION = 1;
/** Files that one submission may cite head-side code from. */
const MAX_CONTEXT_FILES = 30;
const MESSAGE_TEXT_LIMIT = 400;
const URL_PATTERN = /https?:\/\/[^\s<>()"'`\]]+/g;

/** One code change of the stack, as the provider reported it at click time. */
export type WalkthroughGenerationLayer = {
  number: number;
  title: string;
  body: string;
  url: string;
  headSha: string;
  baseSha: string;
  additions: number;
  deletions: number;
};

/**
 * What a generation Turn writes. Only the Walkthrough worker sets this, so
 * `submitWalkthrough` exists only in generation Turns.
 */
export type WalkthroughGeneration = {
  versionId: string;
  provider: string;
  repository: string;
  /** Bottom first. */
  layers: WalkthroughGenerationLayer[];
  sourceConversationId?: string;
  modelId: string;
};

type LoadedDiff = {
  files: WalkthroughDiffFile[];
  skipped: WalkthroughDocument["skipped"];
};

/** Create `submitWalkthrough` for one generation Turn. */
export function createSubmitWalkthroughTool(
  context: ToolRuntimeContext,
  generation: WalkthroughGeneration,
) {
  // Retries in one Turn reuse provider reads.
  let diff: Promise<LoadedDiff> | undefined;
  const fileCache = new Map<string, Promise<string | undefined>>();
  const signal = () => AbortSignal.timeout(30_000);

  const loadDiff = () =>
    (diff ??= Promise.all(
      generation.layers.map(async (layer) =>
        readWalkthroughDiff(
          layer.number,
          (
            await readPluginCodeChangeDiff({
              provider: generation.provider,
              repository: generation.repository,
              baseSha: layer.baseSha,
              headSha: layer.headSha,
              signal: signal(),
            })
          ).files,
        ),
      ),
    ).then((layers) => ({
      files: layers.flatMap((layer) => layer.files),
      skipped: mergeSkipped(layers.flatMap((layer) => layer.skipped)),
    })));

  const loadHeadFile = (pr: number, path: string) => {
    const key = contextFileKey(pr, path);
    let file = fileCache.get(key);
    if (!file) {
      const layer = generation.layers.find((l) => l.number === pr);
      file = layer
        ? readPluginCodeFile({
            provider: generation.provider,
            repository: generation.repository,
            sha: layer.headSha,
            path,
            signal: signal(),
          })
        : Promise.resolve(undefined);
      fileCache.set(key, file);
    }
    return file;
  };

  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description:
      "Submit the Walkthrough for this generation Turn. The runtime checks every citation against the provider and the source Conversation. When it reports problems, fix them and call this again.",
    exposure: "modelOnly",
    inputSchema: walkthroughOutputSchema,
    outputSchema: juniorToolOutputSchema.extend({
      version_id: z.string(),
      excerpts: z.number().int().nonnegative(),
    }),
    execute: async (output) => {
      const { files, skipped } = await loadDiff();
      const codeRefs = codeCitations(output);
      const contextFiles = await readContextFiles(codeRefs, loadHeadFile);
      const messages = await readCitedMessages(context, generation, output);
      const knownUrls = new Set(
        generation.layers.flatMap((layer) => [
          layer.url,
          ...urlsIn(layer.body),
        ]),
      );
      for (const message of messages) {
        for (const url of urlsIn(message.text)) knownUrls.add(url);
      }
      const problems = validateWalkthrough(output, {
        files,
        contextFiles,
        messageSeqs: new Set(messages.map((message) => message.seq)),
        knownUrls,
        checkIds: new Set(),
      });
      if (problems.length > 0) {
        throw new ToolInputError(
          `The Walkthrough has ${problems.length} problem(s). Fix them and call ${SUBMIT_WALKTHROUGH_TOOL_NAME} again:\n${problems.map((p) => `- ${p}`).join("\n")}`,
        );
      }
      if (!context.attachmentStorage) {
        throw new Error("Walkthrough generation needs attachment storage");
      }
      const excerpts = buildWalkthroughExcerpts(codeRefs, files, contextFiles);
      const document: WalkthroughDocument = {
        schemaVersion: WALKTHROUGH_SCHEMA_VERSION,
        versionId: generation.versionId,
        contentVersionId: generation.versionId,
        repository: generation.repository,
        layers: generation.layers.map((layer) => ({
          pr: layer.number,
          title: layer.title,
          url: layer.url,
          headSha: layer.headSha,
          baseSha: layer.baseSha,
          additions: layer.additions,
          deletions: layer.deletions,
        })),
        excerpts,
        skipped,
        checks: [],
        ...(generation.sourceConversationId
          ? { sourceConversationId: generation.sourceConversationId }
          : undefined),
        messages,
        content: output,
        updates: [],
        meta: {
          modelId: generation.modelId,
          promptVersion: WALKTHROUGH_PROMPT_VERSION,
          createdAt: new Date().toISOString(),
        },
      };
      const stored = await completeWalkthroughVersion(
        context.attachmentStorage,
        { id: generation.versionId, document },
      );
      if (!stored) {
        throw new Error(
          `Walkthrough version ${generation.versionId} is no longer generating`,
        );
      }
      return { version_id: generation.versionId, excerpts: excerpts.length };
    },
  });
}

function codeCitations(output: WalkthroughOutput) {
  return output.chapters.flatMap((chapter) =>
    chapter.evidence.flatMap((evidence) =>
      evidence.kind === "code"
        ? [
            {
              pr: evidence.pr,
              path: evidence.path,
              side: evidence.side,
              start: evidence.start,
              end: evidence.end,
            },
          ]
        : [],
    ),
  );
}

/**
 * Read each head-side cited file at its PR's head commit. A citation outside
 * the diff resolves against this text; the validator decides which need it.
 */
async function readContextFiles(
  refs: ReturnType<typeof codeCitations>,
  loadHeadFile: (pr: number, path: string) => Promise<string | undefined>,
): Promise<Map<string, string>> {
  const wanted = new Map(
    refs
      .filter((ref) => ref.side === "head")
      .map((ref) => [contextFileKey(ref.pr, ref.path), ref] as const),
  );
  if (wanted.size > MAX_CONTEXT_FILES) {
    throw new ToolInputError(
      `Cite code from at most ${MAX_CONTEXT_FILES} files.`,
    );
  }
  const contextFiles = new Map<string, string>();
  await Promise.all(
    [...wanted].map(async ([key, ref]) => {
      const text = await loadHeadFile(ref.pr, ref.path);
      if (text !== undefined) contextFiles.set(key, text);
    }),
  );
  return contextFiles;
}

/** Copy the cited messages of the source Conversation that this Actor can read. */
async function readCitedMessages(
  context: ToolRuntimeContext,
  generation: WalkthroughGeneration,
  output: WalkthroughOutput,
): Promise<WalkthroughDocument["messages"]> {
  const sourceId = generation.sourceConversationId;
  if (!sourceId) return [];
  const seqs = [
    ...new Set(
      output.chapters.flatMap((chapter) =>
        chapter.evidence.flatMap((e) => (e.kind === "message" ? [e.seq] : [])),
      ),
    ),
  ];
  if (seqs.length === 0) return [];
  await assertCanReadConversationEvents(context, sourceId);
  const events = getConversationEventStore();
  const messages = await Promise.all(
    seqs.map(async (seq) => {
      const page = await events.query(sourceId, {
        afterSeq: seq - 1,
        beforeSeq: seq + 1,
        limit: 1,
      });
      const data = page.events[0]?.data;
      if (data?.type !== "message" || !data.text.trim()) return [];
      if (data.role !== "user" && data.role !== "assistant") return [];
      return [
        {
          seq,
          role: data.role,
          text: data.text.trim().slice(0, MESSAGE_TEXT_LIMIT),
        },
      ];
    }),
  );
  return messages.flat().sort((a, b) => a.seq - b.seq);
}

function urlsIn(text: string): string[] {
  return [...text.matchAll(URL_PATTERN)].map((match) =>
    match[0].replace(/[.,;:!?]+$/, ""),
  );
}

function mergeSkipped(
  skipped: WalkthroughDocument["skipped"],
): WalkthroughDocument["skipped"] {
  const byReason = new Map<string, WalkthroughDocument["skipped"][number]>();
  for (const entry of skipped) {
    const merged = byReason.get(entry.reason);
    if (merged) {
      merged.files += entry.files;
      merged.lines += entry.lines;
    } else {
      byReason.set(entry.reason, { ...entry });
    }
  }
  return [...byReason.values()];
}
