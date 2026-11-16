import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

/** One Conversation event as the agent conversation tools return it. */
export interface BenchEvent {
  seq: number;
  historyVersion: number;
  createdAt: string;
  data: EventData;
}

/** Event payload fields the benchmark reads. */
export interface EventData {
  type: string;
  text?: unknown;
  content?: unknown;
  provenance?: unknown;
  historyVersion?: unknown;
  markSeq?: unknown;
  costUsd?: unknown;
  details?: unknown;
  summary?: unknown;
  agentName?: unknown;
  payload_omitted?: unknown;
  [key: string]: unknown;
}

/** Refuse a data directory inside a git work tree, so fixtures never get committed. */
export function assertOutsideGit(dir: string): void {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: resolve(dir),
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (root) {
      throw new Error(
        `Data directory ${dir} is inside the git work tree ${root}. Keep benchmark fixtures outside git.`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Data directory")) {
      throw error;
    }
  }
}

function payloadData(type: string, text: string): BenchEvent["data"] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && "type" in parsed) {
      return parsed as BenchEvent["data"];
    }
  } catch {
    // Message payloads come back as rendered text, not JSON.
  }
  return { type, text };
}

/**
 * Merge an export made with `searchConversationEvents` pages and
 * `readConversationEvent` payloads into one ordered event list.
 */
export function mergeExport(dir: string): {
  events: BenchEvent[];
  missing: number[];
} {
  const payloads = new Map<number, BenchEvent["data"]>();
  const payloadDir = join(dir, "payloads");
  if (existsSync(payloadDir)) {
    for (const file of readdirSync(payloadDir)) {
      if (!file.endsWith(".jsonl")) continue;
      for (const line of readFileSync(join(payloadDir, file), "utf8").split(
        "\n",
      )) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as {
          seq: number;
          type: string;
          text: string;
        };
        payloads.set(row.seq, payloadData(row.type, row.text));
      }
    }
  }

  const bySeq = new Map<number, BenchEvent>();
  const missing: number[] = [];
  for (const file of readdirSync(join(dir, "pages")).sort()) {
    const page = JSON.parse(
      readFileSync(join(dir, "pages", file), "utf8"),
    ) as Array<{
      seq: number;
      history_version: number;
      created_at: string;
      data: BenchEvent["data"] & { payload_omitted?: boolean };
    }>;
    for (const event of page) {
      let data: BenchEvent["data"] = event.data;
      if (event.data.payload_omitted) {
        const payload = payloads.get(event.seq);
        if (payload) data = payload;
        else missing.push(event.seq);
      }
      bySeq.set(event.seq, {
        seq: event.seq,
        historyVersion: event.history_version,
        createdAt: event.created_at,
        data,
      });
    }
  }
  const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return { events, missing };
}

/** Write events as JSON lines. */
export function writeEvents(file: string, events: readonly BenchEvent[]) {
  writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n"));
}

/** Read the merged `events.jsonl`. */
export function readEvents(file: string): BenchEvent[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as BenchEvent);
}
