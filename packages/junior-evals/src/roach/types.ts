/**
 * The public types of Roach: rules, modes, runs, and the results of a run.
 * See `README.md` in this directory.
 */
import type { ValuePatterns } from "./values.ts";

/**
 * - `auto`: replay a request that has a recording. Send other requests live
 *   and record them.
 * - `replay`: replay a request that has a recording. Fail other requests
 *   with HTTP 412. Nothing goes live, and nothing is recorded.
 * - `record`: send every request live and record it again.
 * - `off`: record and replay nothing.
 */
export type RecordingMode = "auto" | "off" | "record" | "replay";

/** One kind of traffic that the proxy records. */
export interface RecordingRule {
  /**
   * The name of the rule, such as `model`. Its keys start with
   * `<name>/`. Use letters, digits, `_`, `.`, and `-`.
   */
  name: string;
  /** The requests of the rule. Each field that is set must match. */
  match: {
    /** The method, such as `POST`. */
    method?: string;
    /** The start of the URL, such as `https://ai-gateway.vercel.sh/`. */
    url?: string;
    /** Header values. Names are lowercase. */
    headers?: Record<string, string>;
  };
  /**
   * Request headers that are in the key, with the method, the URL, and the
   * body. Names are lowercase.
   */
  keyHeaders?: string[];
  /**
   * Values in the request body that change from run to run, such as ids and
   * times. See `values.ts`.
   */
  values?: ValuePatterns;
}

/** A request that a rule matched, but that had no recording. */
export interface RecordingMiss {
  rule: string;
  /** The session of the request. */
  session?: string | undefined;
  /** The key of the recording that the request needed. */
  file: string;
}

/** The totals of a run. */
export interface RecordingStats {
  /**
   * Requests by rule name. `missed` counts the requests that `replay` mode
   * failed, because they had no recording.
   */
  counts: Record<string, { live: number; missed: number; replayed: number }>;
  /** The requests without a recording, in order. The first 500 are kept. */
  misses: RecordingMiss[];
  /** Recordings that the proxy wrote and that were new or changed. */
  written: number;
  /** New recordings that the proxy dropped, because their session failed. */
  discarded: number;
  /**
   * Requests that matched no rule, by origin. They went live and were not
   * recorded. Use this to find traffic that a rule misses.
   */
  passthrough: Record<string, number>;
}

/** The configuration of one run. The client sends it. */
export interface RunConfig {
  /**
   * The tenant of the run, as `owner/repo`, such as
   * `process.env.GITHUB_REPOSITORY`.
   */
  tenant: string;
  mode: RecordingMode;
  rules: RecordingRule[];
  /** Default: all origins of the service. */
  allow?: string[];
  /**
   * The name of the run in Sentry, such as
   * `${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`. Default: the run id.
   */
  name?: string;
  /**
   * Credentials that this run must never write, such as the API keys of
   * its CI job. The service redacts them with the `secrets` of the service
   * config, keeps them only in memory, and forgets them when the run ends.
   */
  secrets?: string[];
}

/** A run that the service created. */
export interface RemoteRun {
  /** The id of the run. */
  id: string;
  /** The proxy URL, with the run id and token as its user and password. */
  url: string;
  /** The run token. Session and stats calls use it. */
  token: string;
  /** The base URL of the control API of the run. */
  controlUrl: string;
  /** The PEM certificate of the authority that signs intercepted hosts. */
  caCert: string;
}
