/**
 * Recorded HTTP traffic for the agent test fixture.
 *
 * This module is the one place that decides which outbound requests of an
 * eval are recorded and replayed. MSW sees every request that the Junior
 * process sends, so MSW is the proxy. `RECORDING_RULES` is the list of the
 * traffic that is recorded. To record more traffic, add a rule. Requests that
 * no rule matches are mocked by other fixture modules, or they go live.
 *
 * The key of a request is the hash of its rule, method, URL, and body. JSON
 * bodies are compared with sorted keys, and the key ignores ISO times. A
 * model request body has the model, the system prompt, the messages, the
 * tools, and the settings, so two requests with the same key ask the model
 * the same question. A replayed response makes the agent do the same thing
 * again, so the next request of the turn has the same key too. A change to
 * the prompt, a tool, a skill, or the model changes the key, and that request
 * and the requests after it go live.
 *
 * The environment variable of a rule sets its mode. Unset means `off`.
 *
 * - `off`: every request goes live.
 * - `auto`: a request with a recording gets the recorded response. Other
 *   requests go live.
 * - `record`: every request goes live. Use it to write all recordings again.
 *
 * In `auto` and `record` mode, the fixture writes every recording that a test
 * used, but only when the test passes, so a bad sample is never replayed. A
 * replayed recording is written again with the same content. The nightly
 * workflow uses the file times to delete recordings that no test used. The
 * recordings are in `recordings/<rule>/`, and git tracks them.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bypass, http } from "msw";
import { onTestFinished } from "vitest";
import { USER_AGENT } from "@/chat/tools/web/constants";
import { mswServer } from "@junior-tests/msw/server";

type RecordingMode = "auto" | "off" | "record";

interface RecordingRule {
  name: string;
  /** The environment variable with the mode of this rule. */
  modeEnv: string;
  match(request: Request): boolean;
}

/** The traffic that evals record. */
export const RECORDING_RULES = [
  {
    // Agent, title, and judge requests to the AI Gateway. The gateway
    // observer mocks image generation and web search before this rule.
    name: "model",
    modeEnv: "JUNIOR_EVAL_MODEL_REPLAY",
    match: (request: Request) =>
      request.method === "POST" &&
      request.url.startsWith("https://ai-gateway.vercel.sh/v1/"),
  },
  {
    // Public pages that the `webFetch` tool reads.
    name: "web",
    modeEnv: "VITEST_EVALS_REPLAY_MODE",
    match: (request: Request) =>
      request.method === "GET" &&
      request.headers.get("user-agent") === USER_AGENT,
  },
] as const satisfies readonly RecordingRule[];

type RecordingRuleName = (typeof RECORDING_RULES)[number]["name"];

/** Change this to make every recording a miss. */
const RECORDING_VERSION = "http-v1";

/** Response headers that a recording keeps. Other headers change each run. */
const RECORDED_HEADERS = ["content-type", "location"];

/** Statuses that are never recorded, because they are temporary. */
const isTemporaryStatus = (status: number) => status === 429 || status >= 500;

/** Statuses whose response must not have a body. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

interface Recording {
  writtenAt: string;
  request: { method: string; url: string };
  response: {
    body: string;
    /** `base64` for a body that is not text, such as an image. */
    bodyEncoding: "base64" | "utf8";
    headers: Record<string, string>;
    status: number;
    statusText: string;
  };
}

/** How many requests of a test were replayed and how many were live, by rule. */
// A type alias, so the counts fit the JSON metadata of an eval report.
export type RecordingCounts = Record<
  RecordingRuleName,
  { live: number; replayed: number }
>;

export interface Recordings {
  counts(): RecordingCounts;
  /** Whether a rule matches the request and its mode is not `off`. */
  matches(request: Request): boolean;
  /**
   * Answer a request from a recording, or send it live. A request that no
   * rule matches goes live and is not recorded.
   */
  fetch(request: Request): Promise<Response>;
  /**
   * Write the recordings that the test used. Call it only when the test
   * passed.
   */
  save(): Promise<void>;
}

/** The committed recordings of the eval package. */
const RECORDINGS_DIR = fileURLToPath(
  new URL("../../recordings", import.meta.url),
);

function readMode(name: string): RecordingMode {
  const value = process.env[name]?.trim() || "off";
  if (value === "auto" || value === "off" || value === "record") return value;
  throw new Error(`${name} must be off, auto, or record, got ${value}`);
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
 * The recording key of a request: its rule, method, URL, and body. The key
 * ignores ISO times, because they change on each run and the model does not
 * repeat them in tool calls.
 */
export async function recordingKey(
  rule: string,
  request: Request,
): Promise<string> {
  const text = await request.clone().text();
  let body: string;
  try {
    body = text ? stableStringify(JSON.parse(text)) : "";
  } catch {
    body = text;
  }
  body = body.replace(ISO_TIME, "<time>");
  return createHash("sha256")
    .update(
      [RECORDING_VERSION, rule, request.method, request.url, body].join("\n"),
    )
    .digest("hex");
}

async function readRecording(file: string): Promise<Recording | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Recording;
  } catch {
    return undefined;
  }
}

async function toRecording(
  request: Request,
  response: Response,
): Promise<Recording> {
  const contentType = response.headers.get("content-type");
  const isText = /^text\/|json|xml/i.test(contentType ?? "");
  const headers: Record<string, string> = {};
  for (const name of RECORDED_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return {
    writtenAt: new Date().toISOString(),
    request: { method: request.method, url: request.url },
    response: {
      body: isText
        ? await response.text()
        : Buffer.from(await response.arrayBuffer()).toString("base64"),
      bodyEncoding: isText ? "utf8" : "base64",
      headers,
      status: response.status,
      statusText: response.statusText,
    },
  };
}

function toResponse({ response }: Recording): Response {
  const body = NULL_BODY_STATUSES.has(response.status)
    ? null
    : response.bodyEncoding === "base64"
      ? Buffer.from(response.body, "base64")
      : response.body;
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/**
 * A live response that MSW can return. fetch() already decoded the body, so
 * the encoding headers no longer describe it.
 */
function decoded(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/** Create the recordings of one test. */
export function createRecordings(directory = RECORDINGS_DIR): Recordings {
  const modes = new Map<RecordingRuleName, RecordingMode>(
    RECORDING_RULES.map((rule) => [rule.name, readMode(rule.modeEnv)]),
  );
  const counts = Object.fromEntries(
    RECORDING_RULES.map((rule) => [rule.name, { live: 0, replayed: 0 }]),
  ) as RecordingCounts;
  const used = new Map<string, Recording>();
  const activeRule = (request: Request) =>
    RECORDING_RULES.find(
      (rule) => modes.get(rule.name) !== "off" && rule.match(request),
    );

  return {
    counts: () =>
      Object.fromEntries(
        Object.entries(counts).map(([name, value]) => [name, { ...value }]),
      ) as RecordingCounts,
    matches: (request) => activeRule(request) !== undefined,
    async fetch(request) {
      const rule = activeRule(request);
      if (!rule) return decoded(await fetch(bypass(request)));
      const key = await recordingKey(rule.name, request);
      const file = path.join(directory, rule.name, `${key}.json`);
      if (modes.get(rule.name) === "auto") {
        const recording = await readRecording(file);
        if (recording) {
          counts[rule.name].replayed += 1;
          used.set(file, recording);
          return toResponse(recording);
        }
      }
      counts[rule.name].live += 1;
      // A client that follows redirects gets each one as its own recording.
      const recording = await toRecording(
        request,
        await fetch(bypass(request, { redirect: "manual" })),
      );
      if (!isTemporaryStatus(recording.response.status)) {
        used.set(file, recording);
      }
      return toResponse(recording);
    },
    async save() {
      await Promise.all(
        [...used].map(async ([file, recording]) => {
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, `${JSON.stringify(recording, null, 2)}\n`);
        }),
      );
      used.clear();
    },
  };
}

/**
 * Record and replay the traffic of `RECORDING_RULES` for the current test.
 * Install it before the mocks that answer some of that traffic themselves.
 */
export function installRecordings(): Recordings {
  const recordings = createRecordings();
  // Only a passing test writes recordings, so a bad sample is never replayed.
  onTestFinished(async ({ task }) => {
    if (task.result?.state === "pass") await recordings.save();
  });
  mswServer.use(
    http.all("*", ({ request }) =>
      recordings.matches(request) ? recordings.fetch(request) : undefined,
    ),
  );
  return recordings;
}
