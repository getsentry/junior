/**
 * The traffic that evals record.
 *
 * Global setup starts the recording proxy in `src/recording-proxy/` with
 * this configuration. The proxy knows nothing about Junior. This file is the
 * one place that decides which eval requests are recorded and replayed. To
 * record more traffic, add a rule. `VITEST_EVALS_REPLAY_MODE` sets the mode:
 * `auto` (the default), `replay`, `record`, or `off`.
 * `EVAL_RECORDINGS_USED_FILE` names a file where the proxy lists the
 * recordings that passing tests used. The prune workflow gives these files
 * to `recording-proxy.ts prune`. `EVAL_RECORDING_REQUESTS_DIR` names a
 * directory where the proxy writes each request that had no recording.
 */
import { fileURLToPath } from "node:url";
import { USER_AGENT } from "@/chat/tools/web/constants";
import type {
  RecordingMode,
  RecordingProxyConfig,
  RecordingRule,
} from "./recording-proxy/recording-proxy";
import { VALUE_PATTERNS } from "./recording-proxy/values";

/**
 * Values in model requests that change from run to run. The fixture cannot
 * make them stable: the product makes ids with `randomUUID()`, the prompt
 * shows when each earlier message and memory was stored, and tool results
 * show the current time, the time of a new schedule, or the expiry of a new
 * watch. The proxy keys requests without them, and a replayed response gets
 * the values of the current run (`recording-proxy/values.ts`).
 */
const CHANGING_VALUES = {
  uuid: VALUE_PATTERNS.uuid,
  time: VALUE_PATTERNS.isoTime,
  date: VALUE_PATTERNS.date,
  "epoch-ms": VALUE_PATTERNS.epochMs,
  // A local time for people, such as `Oct 7, 2026, 10:05 PM`, or the file
  // time of `ls -l` in the sandbox, such as `Oct  8 05:04`.
  "local-time": String.raw`\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}\d{1,2}(?:, \d{4}, \d{1,2}:\d{2}\s?[AP]M| \d{2}:\d{2})\b`,
};

const RECORDING_RULES: RecordingRule[] = [
  {
    // Every model request to the AI Gateway. The gateway observer mocks
    // image generation and web search before the proxy.
    name: "model",
    match: { method: "POST", url: "https://ai-gateway.vercel.sh/" },
    key: {
      // AI SDK gateway requests, such as `/v3/ai/language-model`, name the
      // model in a header, not in the body.
      headers: [
        "ai-language-model-id",
        "ai-language-model-streaming",
        "ai-model-id",
      ],
    },
    values: CHANGING_VALUES,
  },
  {
    // Public pages that the `webFetch` tool reads.
    name: "web",
    match: { method: "GET", headers: { "user-agent": USER_AGENT } },
  },
];

/**
 * The only origins that eval traffic can reach through the proxy. The proxy
 * refuses all other origins. MSW mocks, such as Slack and GitHub, answer
 * before the proxy, so they are not in this list. To let an eval reach a new
 * site, add its origin here.
 */
const ALLOWED_ORIGINS = [
  // Model requests.
  "https://ai-gateway.vercel.sh",
  // The Vercel Sandbox API and Vercel OIDC tokens.
  "https://vercel.com",
  "https://api.vercel.com",
  "https://oidc.vercel.com",
  // Pages that `webFetch` evals read.
  "https://docs.slack.dev",
];

/**
 * Hosts that do not use the proxy. Local fixture servers, Postgres, and
 * Redis are on loopback. The Quick Tunnel of the sandbox egress
 * (`src/eval-egress.ts`) is on Cloudflare, which the CI network allows
 * directly (`scripts/network-jail.sh`).
 */
export const NO_PROXY = "localhost,127.0.0.1,::1,.trycloudflare.com";

/** The committed recordings of the eval package. */
const RECORDINGS_DIR = fileURLToPath(new URL("../recordings", import.meta.url));

function readMode(): RecordingMode {
  const value = process.env.VITEST_EVALS_REPLAY_MODE?.trim() || "auto";
  if (
    value === "auto" ||
    value === "off" ||
    value === "record" ||
    value === "replay"
  ) {
    return value;
  }
  throw new Error(
    `VITEST_EVALS_REPLAY_MODE must be auto, replay, record, or off, got ${value}`,
  );
}

/** The recording proxy configuration of this eval run. */
export function recordingProxyConfig(): RecordingProxyConfig {
  return {
    directory: RECORDINGS_DIR,
    mode: readMode(),
    allow: ALLOWED_ORIGINS,
    rules: RECORDING_RULES,
    usedFile: process.env.EVAL_RECORDINGS_USED_FILE?.trim() || undefined,
    requestDirectory:
      process.env.EVAL_RECORDING_REQUESTS_DIR?.trim() || undefined,
  };
}
