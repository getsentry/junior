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
import { completeObject } from "@/chat/pi/client";
import {
  defaultBriefModelId,
  DEFAULT_BRIEF_PROMPT,
} from "@/chat/briefs/config";
import {
  generateBrief,
  type BriefCompleteObject,
  type GeneratedBrief,
} from "@/chat/briefs/generate";
import { renderBriefMarkdown } from "@/chat/briefs/render";
import {
  briefInputFromSnapshot,
  completedTurnIndexesFromSnapshot,
  conversationSnapshotSchema,
  createConversationSnapshot,
  throughIndexFromSnapshot,
  type ConversationSnapshot,
} from "@/chat/briefs/snapshot";

export const BRIEFS_USAGE = `usage: junior briefs pull <conversationId...> --base-url <url> [--token <token>] --out <dir>
       junior briefs run <snapshot...> [--model <id>] [--prompt <file>] [--turn-by-turn] [--out <dir>]`;

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

type BriefsDeps = {
  completeObject: BriefCompleteObject;
  fetch: typeof fetch;
  log: (line: string) => void;
};

const DEFAULT_DEPS: BriefsDeps = {
  completeObject: async (request) => await completeObject(request),
  fetch,
  log: console.log,
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
    throw new Error(BRIEFS_USAGE);
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
  if (snapshots.length === 0) throw new Error(BRIEFS_USAGE);
  return {
    model: model ?? (await defaultBriefModelId()),
    out,
    promptFile,
    snapshots,
    turnByTurn,
  };
}

function apiUrl(baseUrl: string, pathname: string): URL {
  const base = new URL(baseUrl);
  base.pathname = `${base.pathname.replace(/\/*$/, "")}/`;
  base.search = "";
  base.hash = "";
  return new URL(pathname.replace(/^\//, ""), base);
}

async function fetchJson(
  url: URL,
  token: string,
  request: typeof fetch,
): Promise<unknown> {
  const response = await request(url, {
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
  request: typeof fetch,
): Promise<ConversationSnapshot> {
  const detailUrl = apiUrl(
    options.baseUrl,
    `api/conversations/${encodeURIComponent(conversationId)}`,
  );
  detailUrl.searchParams.set("limit", "1000");
  const detail = conversationDetailReportSchema.parse(
    await fetchJson(detailUrl, options.token, request),
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
      await fetchJson(eventsUrl, options.token, request),
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

async function pullAll(options: PullOptions, deps: BriefsDeps): Promise<void> {
  await mkdir(options.out, { recursive: true });
  for (const conversationId of options.conversationIds) {
    const snapshot = await pullSnapshot(options, conversationId, deps.fetch);
    const output = path.join(
      options.out,
      `${fileStem(snapshot.detail.conversationId)}.snapshot.json`,
    );
    await writeFile(output, `${JSON.stringify(snapshot, undefined, 2)}\n`);
    deps.log(output);
  }
}

function generationIndexes(
  snapshot: ConversationSnapshot,
  turnByTurn: boolean,
  throughIndex: number,
): number[] {
  if (!turnByTurn) return [throughIndex];
  const indexes = completedTurnIndexesFromSnapshot(snapshot).filter(
    (index) => index >= 0,
  );
  if (indexes.length === 0) {
    throw new Error("Snapshot has no completed turns");
  }
  return indexes;
}

async function runSnapshot(
  snapshotPath: string,
  options: RunOptions,
  prompt: string,
  deps: BriefsDeps,
): Promise<void> {
  const snapshot = conversationSnapshotSchema.parse(
    JSON.parse(await readFile(snapshotPath, "utf8")),
  );
  const input = briefInputFromSnapshot(snapshot);
  if (input.entries.length === 0) {
    throw new Error(`Snapshot ${snapshotPath} has no Brief entries`);
  }
  const finalThroughIndex = throughIndexFromSnapshot(snapshot);
  if (finalThroughIndex === undefined) {
    throw new Error(`Snapshot ${snapshotPath} has no Conversation events`);
  }
  const versions: GeneratedBrief[] = [];
  for (const throughIndex of generationIndexes(
    snapshot,
    options.turnByTurn,
    finalThroughIndex,
  )) {
    const generation = await generateBrief({
      input,
      previous: versions.at(-1)?.brief,
      throughIndex,
      prompt,
      model: options.model,
      completeObject: deps.completeObject,
    });
    versions.push(generation);
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
  const finalGeneration = versions.at(-1)!;
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, undefined, 2)}\n`),
    writeFile(
      markdownPath,
      renderBriefMarkdown({
        generation: finalGeneration,
        input,
        model: options.model,
        totalCostUsd,
        versionCount: versions.length,
      }),
    ),
  ]);
  deps.log(jsonPath);
  deps.log(markdownPath);
}

async function runAll(options: RunOptions, deps: BriefsDeps): Promise<void> {
  const prompt = options.promptFile
    ? await readFile(options.promptFile, "utf8")
    : DEFAULT_BRIEF_PROMPT;
  if (!prompt.trim()) throw new Error("Brief prompt must not be empty");
  await mkdir(options.out, { recursive: true });
  for (const snapshot of options.snapshots) {
    await runSnapshot(snapshot, options, prompt, deps);
  }
}

/** Run `junior briefs pull` or `junior briefs run`. */
export async function runBriefs(
  argv: string[],
  deps: Partial<BriefsDeps> = {},
): Promise<number> {
  const resolvedDeps = { ...DEFAULT_DEPS, ...deps };
  try {
    const [subcommand, ...rest] = argv;
    if (subcommand === "pull") {
      await pullAll(parsePullOptions(rest), resolvedDeps);
      return 0;
    }
    if (subcommand === "run") {
      await runAll(await parseRunOptions(rest), resolvedDeps);
      return 0;
    }
    throw new Error(BRIEFS_USAGE);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
