/**
 * Model response replay for the agent test fixture.
 *
 * The key of a model request is the hash of its endpoint and its body. The
 * body has the model, the system prompt, the messages, the tools, and the
 * settings, so two requests with the same key ask the model the same
 * question. The key ignores ISO times. The Slack mock makes the other run
 * values, such as Slack timestamps and Conversation ids, the same on each
 * run. A replayed response makes the agent do the same thing again, so
 * the next request of the turn has the same key too. A change to the prompt,
 * a tool, a skill, or the model changes the key, and that request and the
 * requests after it go to the live model.
 *
 * `JUNIOR_EVAL_MODEL_REPLAY` sets the mode:
 *
 * - `off` (default): every request goes to the live model.
 * - `auto`: a request with a recording younger than the TTL gets the
 *   recorded response. Other requests go to the live model.
 * - `record`: every request goes to the live model. Use it to refresh the
 *   recordings.
 *
 * In `auto` and `record` mode, the fixture writes the live responses of a
 * test only when the test passes, so a bad sample is never replayed. The
 * recordings are in `.vitest-evals/recordings/model/`.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { bypass } from "msw";

type ModelReplayMode = "auto" | "off" | "record";

/** A recording older than this is not replayed. */
const RECORDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Change this to make every recording a miss. */
const RECORDING_VERSION = "model-v1";

interface ModelRecording {
  body: string;
  contentType: string | null;
  writtenAt: string;
}

/** A model response with its body already read. */
export interface ModelResponse {
  body: string;
  headers: Headers;
  status: number;
  statusText: string;
}

/** How many model requests of a test were replayed and how many were live. */
// A type alias, so the counts fit the JSON metadata of an eval report.
export type ModelReplayCounts = {
  live: number;
  replayed: number;
};

export interface ModelReplay {
  counts(): ModelReplayCounts;
  /** Whether the mode is `auto` or `record`. */
  enabled: boolean;
  /** Write the live responses of the test. Call it only when the test passed. */
  save(): Promise<void>;
  /** Answer a model request from a recording, or send it to the live model. */
  send(request: Request): Promise<ModelResponse>;
}

function readMode(): ModelReplayMode {
  const value = process.env.JUNIOR_EVAL_MODEL_REPLAY?.trim() || "off";
  if (value === "auto" || value === "off" || value === "record") return value;
  throw new Error(
    `JUNIOR_EVAL_MODEL_REPLAY must be off, auto, or record, got ${value}`,
  );
}

function recordingDirectory(): string {
  return path.resolve(
    process.cwd(),
    process.env.VITEST_EVALS_REPLAY_DIR ?? ".vitest-evals/recordings",
    "model",
  );
}

/** JSON with sorted object keys, so equal bodies give equal keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

/**
 * An ISO time. The prompt shows when each earlier message was stored, and
 * that is the clock time of the run.
 */
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

/**
 * The recording key of a model request: its endpoint and its body. The key
 * ignores ISO times, because they change on each run and the model does not
 * repeat them in tool calls.
 */
export async function modelRequestKey(request: Request): Promise<string> {
  const text = await request.clone().text();
  let body: string;
  try {
    body = stableStringify(JSON.parse(text));
  } catch {
    body = text;
  }
  body = body.replace(ISO_TIME, "<time>");
  return createHash("sha256")
    .update(RECORDING_VERSION)
    .update("\n")
    .update(new URL(request.url).pathname)
    .update("\n")
    .update(body)
    .digest("hex");
}

async function readFreshRecording(
  file: string,
  nowMs: number,
): Promise<ModelRecording | undefined> {
  let recording: ModelRecording;
  try {
    recording = JSON.parse(await readFile(file, "utf8")) as ModelRecording;
  } catch {
    return undefined;
  }
  const writtenAtMs = Date.parse(recording.writtenAt);
  if (!(nowMs - writtenAtMs < RECORDING_TTL_MS)) return undefined;
  return recording;
}

/** Create the model replay of one test. */
export function createModelReplay(): ModelReplay {
  const mode = readMode();
  const directory = recordingDirectory();
  const unsaved = new Map<string, ModelRecording>();
  const counts: ModelReplayCounts = { live: 0, replayed: 0 };

  return {
    counts: () => ({ ...counts }),
    enabled: mode !== "off",
    async save() {
      if (mode === "off" || unsaved.size === 0) return;
      await mkdir(directory, { recursive: true });
      await Promise.all(
        [...unsaved].map(([key, recording]) =>
          writeFile(
            path.join(directory, `${key}.json`),
            JSON.stringify(recording, null, 2),
          ),
        ),
      );
      unsaved.clear();
    },
    async send(request) {
      const key = mode === "off" ? undefined : await modelRequestKey(request);
      if (key && mode === "auto") {
        const recording = await readFreshRecording(
          path.join(directory, `${key}.json`),
          Date.now(),
        );
        if (recording) {
          counts.replayed += 1;
          return {
            body: recording.body,
            headers: new Headers(
              recording.contentType
                ? { "content-type": recording.contentType }
                : {},
            ),
            status: 200,
            statusText: "OK",
          };
        }
      }
      counts.live += 1;
      const response = await fetch(bypass(request));
      const body = await response.text();
      // fetch() already decoded the body, so drop the encoding headers.
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      if (key && response.ok) {
        unsaved.set(key, {
          body,
          contentType: response.headers.get("content-type"),
          writtenAt: new Date().toISOString(),
        });
      }
      return {
        body,
        headers,
        status: response.status,
        statusText: response.statusText,
      };
    },
  };
}
