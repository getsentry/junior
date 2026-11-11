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
  codeLineUrl,
  readPluginCodeChangeDiff,
  readPluginCodeFile,
} from "@/chat/plugins/code-change-hooks";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { WalkthroughCodeChange } from "@/db/schema/walkthroughs";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { readWalkthroughDiff, type WalkthroughDiffFile } from "./diff";
import { buildWalkthroughExcerpts } from "./excerpts";
import {
  WALKTHROUGH_SCHEMA_VERSION,
  walkthroughOutputSchema,
  type WalkthroughCodeRef,
  type WalkthroughDocument,
  type WalkthroughEvidence,
  type WalkthroughExcerpt,
} from "./schema";
import { completeWalkthroughVersion } from "./store";
import { walkthroughFileHashes } from "./update";
import {
  contextFileKey,
  validateWalkthrough,
  type WalkthroughInputRefs,
} from "./validate";

export const SUBMIT_WALKTHROUGH_TOOL_NAME = "submitWalkthrough";
/** Bump when the skill or tool contract changes what the model writes. */
export const WALKTHROUGH_PROMPT_VERSION = 4;
/** Files that one submission may cite head-side code from. */
const MAX_CONTEXT_FILES = 30;
const MESSAGE_TEXT_LIMIT = 400;
const URL_PATTERN = /https?:\/\/[^\s<>()"'`\]]+/g;

/**
 * What a generation Turn writes. Only the Walkthrough worker sets this, so
 * `submitWalkthrough` exists only in generation Turns.
 */
export type WalkthroughGeneration = {
  versionId: string;
  provider: string;
  repository: string;
  /** Bottom first. */
  layers: WalkthroughCodeChange[];
  sourceConversationId?: string;
  /** The version an update builds on. A full generation has none. */
  parentVersionId?: string;
  modelId: string;
};

type LoadedDiff = {
  files: WalkthroughDiffFile[];
  skipped: WalkthroughDocument["skipped"];
};

/** Provider reads that the tools of one generation Turn share. */
export type WalkthroughReads = ReturnType<typeof createWalkthroughReads>;

/**
 * Create the provider reads for one generation Turn. Retries and every tool
 * of the Turn reuse them.
 */
export function createWalkthroughReads(generation: WalkthroughGeneration) {
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

  return { loadDiff, loadHeadFile };
}

/** Create `submitWalkthrough` for one full generation Turn. */
export function createSubmitWalkthroughTool(
  context: ToolRuntimeContext,
  generation: WalkthroughGeneration,
  reads: WalkthroughReads,
) {
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
      const evidence = output.chapters.flatMap((chapter) => chapter.evidence);
      const codeRefs = codeCitations(evidence);
      const [{ files, skipped }, contextFiles, messages] = await Promise.all([
        reads.loadDiff(),
        readContextFiles(codeRefs, reads.loadHeadFile),
        readCitedMessages(context, generation, evidence),
      ]);
      const problems = validateWalkthrough(
        output,
        inputRefs(generation, files, contextFiles, messages),
      );
      if (problems.length > 0) {
        throw new ToolInputError(
          `The Walkthrough has ${problems.length} problem(s). Fix them and call ${SUBMIT_WALKTHROUGH_TOOL_NAME} again:\n${problems.map((p) => `- ${p}`).join("\n")}`,
        );
      }
      const excerpts = linkedExcerpts(
        generation,
        buildWalkthroughExcerpts(codeRefs, files, contextFiles),
      );
      const document: WalkthroughDocument = {
        schemaVersion: WALKTHROUGH_SCHEMA_VERSION,
        versionId: generation.versionId,
        contentVersionId: generation.versionId,
        repository: generation.repository,
        layers: documentLayers(generation),
        excerpts,
        files: walkthroughFileHashes(files),
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
      await storeWalkthrough(context, document);
      return { version_id: generation.versionId, excerpts: excerpts.length };
    },
  });
}

/** Store a checked document and mark its version ready. */
export async function storeWalkthrough(
  context: ToolRuntimeContext,
  document: WalkthroughDocument,
): Promise<void> {
  if (!context.attachmentStorage) {
    throw new Error("Walkthrough generation needs attachment storage");
  }
  const stored = await completeWalkthroughVersion(context.attachmentStorage, {
    id: document.versionId,
    document,
  });
  if (!stored) {
    throw new Error(
      `Walkthrough version ${document.versionId} is no longer generating`,
    );
  }
}

/** The stack layers as a document stores them. */
export function documentLayers(
  generation: WalkthroughGeneration,
): WalkthroughDocument["layers"] {
  return generation.layers.map((layer) => ({
    pr: layer.number,
    title: layer.title,
    url: layer.url,
    headSha: layer.headSha,
    baseSha: layer.baseSha,
    additions: layer.additions,
    deletions: layer.deletions,
  }));
}

/** What a submission may cite, as read from the provider and the source. */
export function inputRefs(
  generation: WalkthroughGeneration,
  files: WalkthroughDiffFile[],
  contextFiles: Map<string, string>,
  messages: WalkthroughDocument["messages"],
): WalkthroughInputRefs {
  const knownUrls = new Set(
    generation.layers.flatMap((layer) => [layer.url, ...urlsIn(layer.body)]),
  );
  for (const message of messages) {
    for (const url of urlsIn(message.text)) knownUrls.add(url);
  }
  return {
    prs: new Set(generation.layers.map((layer) => layer.number)),
    files,
    contextFiles,
    messageSeqs: new Set(messages.map((message) => message.seq)),
    knownUrls,
    checkIds: new Set(),
  };
}

/** Link each excerpt to its first line at the cited commit. */
export function linkedExcerpts(
  generation: WalkthroughGeneration,
  excerpts: WalkthroughExcerpt[],
): WalkthroughExcerpt[] {
  return excerpts.map((excerpt) => {
    const layer = generation.layers.find((l) => l.number === excerpt.pr);
    const url =
      layer &&
      codeLineUrl({
        provider: generation.provider,
        repository: generation.repository,
        sha: excerpt.side === "head" ? layer.headSha : layer.baseSha,
        path: excerpt.path,
        line: excerpt.start,
      });
    return url ? { ...excerpt, url } : excerpt;
  });
}

/** The code citations in a list of evidence, without notes. */
export function codeCitations(
  evidence: readonly WalkthroughEvidence[],
): WalkthroughCodeRef[] {
  return evidence.flatMap((e) =>
    e.kind === "code"
      ? [{ pr: e.pr, path: e.path, side: e.side, start: e.start, end: e.end }]
      : [],
  );
}

/**
 * Read each head-side cited file at its PR's head commit. A citation outside
 * the diff resolves against this text; the validator decides which need it.
 */
export async function readContextFiles(
  refs: readonly WalkthroughCodeRef[],
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
export async function readCitedMessages(
  context: ToolRuntimeContext,
  generation: WalkthroughGeneration,
  evidence: readonly WalkthroughEvidence[],
): Promise<WalkthroughDocument["messages"]> {
  const sourceId = generation.sourceConversationId;
  if (!sourceId) return [];
  const seqs = [
    ...new Set(evidence.flatMap((e) => (e.kind === "message" ? [e.seq] : []))),
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
