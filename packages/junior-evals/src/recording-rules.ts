/**
 * The traffic that evals record.
 *
 * Global setup starts a run on Roach, the shared recording service
 * (`src/roach/`), with this configuration. Roach knows nothing about Junior.
 * This file is the one place that decides which eval requests are recorded
 * and replayed. To record more traffic, add a rule. `VITEST_EVALS_REPLAY_MODE`
 * sets the mode: `auto`, `replay`, `record`, or `off`. Without it, a run with
 * the write token (`ROACH_TOKEN`) uses `auto`, and a run without it uses
 * `replay`, because the service allows only `replay` without the token.
 */
import { USER_AGENT } from "@/chat/tools/web/constants";
import type { RecordingMode, RecordingRule, RunConfig } from "./roach/types";
import { NOT_AFTER_WORD, VALUE_PATTERNS } from "./roach/values";

/**
 * Values in model requests that change from run to run. The fixture cannot
 * make them stable: the product makes ids with `randomUUID()`, the prompt
 * shows when each earlier message and memory was stored, and tool results
 * show the current time, the time of a new schedule, or the expiry of a new
 * watch. The proxy keys requests without them, and a replayed response gets
 * the values of the current run (`roach/values.ts`).
 */
const CHANGING_VALUES = {
  uuid: VALUE_PATTERNS.uuid,
  time: VALUE_PATTERNS.isoTime,
  date: VALUE_PATTERNS.date,
  "epoch-ms": VALUE_PATTERNS.epochMs,
  // Attachment ids hash the file name, which has the time in milliseconds.
  sha256: VALUE_PATTERNS.sha256,
  // Commits that the agent makes in the Vercel Sandbox.
  "git-commit": VALUE_PATTERNS.gitCommit,
  // A local time for people, such as `Oct 7, 2026, 10:05 PM`, or the file
  // time of `ls -l` in the sandbox, such as `Oct  8 05:04`.
  "local-time": String.raw`${NOT_AFTER_WORD}(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}\d{1,2}(?:, \d{4}, \d{1,2}:\d{2}\s?[AP]M| \d{2}:\d{2})\b`,
  // The reference of a failure reply, such as `event_id=59063a3f...`.
  "event-id": String.raw`(?<=event_id=)[0-9a-f]{32}(?![0-9A-Za-z])`,
};

const RECORDING_RULES: RecordingRule[] = [
  {
    // Every model request to the AI Gateway. The gateway observer mocks
    // image generation and web search before the proxy.
    name: "model",
    match: { method: "POST", url: "https://ai-gateway.vercel.sh/" },
    // AI SDK gateway requests, such as `/v3/ai/language-model`, name the
    // model in a header, not in the body.
    keyHeaders: [
      "ai-language-model-id",
      "ai-language-model-streaming",
      "ai-model-id",
    ],
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

/**
 * The Roach service of Sentry. See "Deploy" in the `README.md` of
 * `getsentry/roach`.
 */
export const ROACH_URL = "https://roach-proxy.getsentry.net";

/**
 * The tenant of the recordings. Each local and CI run of Junior evals uses
 * the same recordings, also a run of a fork.
 */
const TENANT = "getsentry/junior";

function readMode(canWrite: boolean): RecordingMode {
  const value =
    process.env.VITEST_EVALS_REPLAY_MODE?.trim() ||
    (canWrite ? "auto" : "replay");
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

/**
 * Environment variables with real credentials in CI. The service never
 * writes their values, also when a response shows one, such as a model that
 * repeats a token from its prompt. It also learns credentials from request
 * headers.
 */
const SECRET_ENV = [
  "AI_GATEWAY_API_KEY",
  "SENTRY_EVALS_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "VERCEL_TOKEN",
];

/**
 * The Roach run configuration of this eval invocation. `canWrite` tells if
 * the invocation has the write token of the service.
 */
export function roachRunConfig(canWrite: boolean): RunConfig {
  const config: RunConfig = {
    tenant: TENANT,
    mode: readMode(canWrite),
    allow: ALLOWED_ORIGINS,
    rules: RECORDING_RULES,
    secrets: SECRET_ENV.flatMap((name) => process.env[name]?.trim() || []),
  };
  // The name of the run in the metrics of the service.
  const runId = process.env.GITHUB_RUN_ID?.trim();
  if (runId) {
    config.name = `${runId}-${process.env.GITHUB_RUN_ATTEMPT?.trim() || "1"}`;
  }
  return config;
}
