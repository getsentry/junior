/**
 * Local Brief snapshot and replay CLI.
 *
 * This module owns dashboard download pagination and local files. The Brief
 * module owns projection, generation, evidence checks, and rendering.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  conversationDetailReportSchema,
  conversationEventPageSchema,
} from "@/api/schema/conversation";
import { generateBrief, type GeneratedBrief } from "@/chat/briefs/generate";
import { BRIEF_PROMPT } from "@/chat/briefs/prompt";
import { renderBriefMarkdown } from "@/chat/briefs/render";
import {
  briefInputFromSnapshot,
  completedTurnIndexesFromSnapshot,
  conversationSnapshotSchema,
  createConversationSnapshot,
  throughIndexFromSnapshot,
  type ConversationSnapshot,
} from "@/chat/briefs/snapshot";
import { defaultModelId } from "@/chat/model-profile";
import { completeObject } from "@/chat/pi/client";
import { CLI_USAGE } from "./run";

type PullOptions = {
  baseUrl: string;
  conversationIds: string[];
  out: string;
  token: string;
};

type RunOptions = {
  model: string;
  out: string;
  promptFile?: string;
  snapshots: string[];
  turnByTurn: boolean;
};

function optionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parsePullOptions(argv: string[]): PullOptions {
  const conversationIds: string[] = [];
  let baseUrl: string | undefined;
  let token = process.env.JUNIOR_API_TOKEN?.trim();
  let out: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--base-url") {
      baseUrl = optionValue(argv, index, argument);
      index += 1;
    } else if (argument === "--token") {
      token = optionValue(argv, index, argument);
      index += 1;
    } else if (argument === "--out") {
      out = optionValue(argv, index, argument);
      index += 1;
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      conversationIds.push(argument);
    }
  }
  if (!baseUrl || !token || !out || conversationIds.length === 0) {
    throw new Error(CLI_USAGE);
  }
  return { baseUrl, conversationIds, out, token };
}

async function parseRunOptions(argv: string[]): Promise<RunOptions> {
  const snapshots: string[] = [];
  let model: string | undefined;
  let promptFile: string | undefined;
  let out = process.cwd();
  let turnByTurn = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--model") {
      model = optionValue(argv, index, argument);
      index += 1;
    } else if (argument === "--prompt") {
      promptFile = optionValue(argv, index, argument);
      index += 1;
    } else if (argument === "--out") {
      out = optionValue(argv, index, argument);
      index += 1;
    } else if (argument === "--turn-by-turn") {
      turnByTurn = true;
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      snapshots.push(argument);
    }
  }
  if (snapshots.length === 0) throw new Error(CLI_USAGE);
  return {
    model: model ?? (await configuredDefaultModelId()),
    out,
    promptFile,
    snapshots,
    turnByTurn,
  };
}

/**
 * Read the app default model only when a run needs it. `chat/config` reads
 * `DATABASE_URL` at import, and `briefs pull` must work with only a token.
 */
async function configuredDefaultModelId(): Promise<string> {
  const { botConfig } = await import("@/chat/config");
  return defaultModelId(botConfig);
}

function apiUrl(baseUrl: string, pathname: string): URL {
  const base = new URL(baseUrl);
  base.pathname = `${base.pathname.replace(/\/*$/, "")}/`;
  base.search = "";
  base.hash = "";
  return new URL(pathname.replace(/^\//, ""), base);
}

async function fetchJson(url: URL, token: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    const body = (await response.text()).trim().slice(0, 500);
    throw new Error(
      `Dashboard request failed (${response.status} ${response.statusText})${body ? `: ${body}` : ""}`,
    );
  }
  return await response.json();
}

async function pullSnapshot(
  options: PullOptions,
  conversationId: string,
): Promise<ConversationSnapshot> {
  const detailUrl = apiUrl(
    options.baseUrl,
    `api/conversations/${encodeURIComponent(conversationId)}`,
  );
  detailUrl.searchParams.set("limit", "1000");
  const detail = conversationDetailReportSchema.parse(
    await fetchJson(detailUrl, options.token),
  );
  const eventPages = [];
  const seenCursors = new Set<string>();
  let cursor = detail.previousCursor;
  while (cursor) {
    if (seenCursors.has(cursor)) {
      throw new Error(
        `Conversation ${conversationId} repeated an event cursor`,
      );
    }
    seenCursors.add(cursor);
    const eventsUrl = apiUrl(
      options.baseUrl,
      `api/conversations/${encodeURIComponent(conversationId)}/events`,
    );
    eventsUrl.searchParams.set("before", cursor);
    eventsUrl.searchParams.set("limit", "1000");
    const page = conversationEventPageSchema.parse(
      await fetchJson(eventsUrl, options.token),
    );
    eventPages.push(page);
    cursor = page.previousCursor;
  }
  return createConversationSnapshot({ detail, eventPages });
}

function fileStem(conversationId: string): string {
  const stem = conversationId.replaceAll(/[\\/\0]/g, "_");
  if (!stem || stem === "." || stem === "..") {
    throw new Error("Conversation id cannot be used as a file name");
  }
  return stem;
}

async function pullAll(options: PullOptions): Promise<void> {
  await mkdir(options.out, { recursive: true });
  for (const conversationId of options.conversationIds) {
    const snapshot = await pullSnapshot(options, conversationId);
    const output = path.join(
      options.out,
      `${fileStem(snapshot.detail.conversationId)}.snapshot.json`,
    );
    await writeFile(output, `${JSON.stringify(snapshot, undefined, 2)}\n`);
    console.log(output);
  }
}

function generationIndexes(
  snapshot: ConversationSnapshot,
  turnByTurn: boolean,
  throughIndex: number,
): number[] {
  if (!turnByTurn) return [throughIndex];
  const indexes = completedTurnIndexesFromSnapshot(snapshot);
  if (indexes.length === 0) {
    throw new Error("Snapshot has no completed turns");
  }
  return indexes;
}

async function runSnapshot(
  snapshotPath: string,
  options: RunOptions,
  prompt: string,
): Promise<void> {
  const snapshot = conversationSnapshotSchema.parse(
    JSON.parse(await readFile(snapshotPath, "utf8")),
  );
  const finalThroughIndex = throughIndexFromSnapshot(snapshot);
  if (finalThroughIndex === undefined) {
    throw new Error(`Snapshot ${snapshotPath} has no Conversation events`);
  }
  const input = briefInputFromSnapshot(snapshot, finalThroughIndex);
  const versions: GeneratedBrief[] = [];
  for (const throughIndex of generationIndexes(
    snapshot,
    options.turnByTurn,
    finalThroughIndex,
  )) {
    versions.push(
      await generateBrief({
        completeObject: (request) =>
          completeObject({ ...request, modelId: options.model }),
        input: briefInputFromSnapshot(snapshot, throughIndex),
        previous: versions.at(-1)?.brief,
        prompt,
        throughIndex,
      }),
    );
  }
  const costs = versions.flatMap((version) =>
    version.costUsd === undefined ? [] : [version.costUsd],
  );
  const totalCostUsd =
    costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) : undefined;
  const stem = fileStem(input.conversationId);
  const jsonPath = path.join(options.out, `${stem}.brief.json`);
  const markdownPath = path.join(options.out, `${stem}.brief.md`);
  const report = {
    schemaVersion: 1,
    conversationId: input.conversationId,
    model: options.model,
    versions,
    ...(totalCostUsd !== undefined ? { totalCostUsd } : undefined),
  };
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, undefined, 2)}\n`),
    writeFile(
      markdownPath,
      renderBriefMarkdown({
        generation: versions.at(-1)!,
        input,
        model: options.model,
        totalCostUsd,
        versionCount: versions.length,
      }),
    ),
  ]);
  console.log(jsonPath);
  console.log(markdownPath);
}

async function runAll(options: RunOptions): Promise<void> {
  const prompt = options.promptFile
    ? await readFile(options.promptFile, "utf8")
    : BRIEF_PROMPT;
  if (!prompt.trim()) throw new Error("Brief prompt must not be empty");
  await mkdir(options.out, { recursive: true });
  for (const snapshot of options.snapshots) {
    await runSnapshot(snapshot, options, prompt);
  }
}

/** Run `junior briefs pull` or `junior briefs run`. */
export async function runBriefs(argv: string[]): Promise<number> {
  try {
    const [subcommand, ...rest] = argv;
    if (subcommand === "pull") {
      await pullAll(parsePullOptions(rest));
      return 0;
    }
    if (subcommand === "run") {
      await runAll(await parseRunOptions(rest));
      return 0;
    }
    throw new Error(CLI_USAGE);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
