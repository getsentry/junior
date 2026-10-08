/**
 * The public types of the recording proxy: its configuration and its
 * results. See `README.md` in this directory.
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
  /** The name of the rule. Its recordings are in `<directory>/<name>/`. */
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

/** The configuration of one proxy. */
export interface RecordingProxyConfig {
  /** The directory of the recordings. Each rule has a subdirectory. */
  directory: string;
  mode: RecordingMode;
  /**
   * The only origins that the proxy sends requests to, such as
   * `https://ai-gateway.vercel.sh`. The proxy refuses all other origins.
   */
  allow: string[];
  rules: RecordingRule[];
  /**
   * When the proxy stops, it lists here the recordings that sessions used.
   * A failed session uses all recordings that it recorded before. Give these
   * files to the `prune` command.
   */
  usedFile?: string;
  /**
   * For each miss, the proxy writes the request as the key sees it to
   * `<missDirectory>/<rule>/<key>.json`. These files contain request
   * bodies, such as prompts, so do not commit them.
   */
  missDirectory?: string;
}

/** A request that a rule matched, but that had no recording. */
export interface RecordingMiss {
  rule: string;
  /** The session of the request. */
  session?: string;
  /** The recording file that the request needed, relative to `directory`. */
  file: string;
  /** The recording with the most equal parts, relative to `directory`. */
  closest?: string;
  /** The parts that differ from `closest`, such as `messages[3]`. */
  differs: string[];
}

/** The totals of a proxy run. */
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

/** The address of a running proxy. Give it to the processes that use it. */
export interface RecordingProxyAddress {
  /** The proxy URL, such as `http://127.0.0.1:1234`. */
  url: string;
  /** The bearer token of the control API. */
  token: string;
  /** The PEM certificate of the authority that signs intercepted hosts. */
  caCert: string;
}
