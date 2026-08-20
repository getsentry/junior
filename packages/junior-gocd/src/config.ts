/** Host-configurable GoCD connection settings. */

import { z } from "zod";

export interface GocdPluginOptions {
  /**
   * Optional default GoCD base URL, for example `https://gocd.example.com`.
   * When omitted, tools require `GOCD_URL` or a per-call `baseUrl`.
   */
  baseUrl?: string;
  /**
   * Hostname used for egress domain ownership and header injection.
   * Defaults from `baseUrl` / `GOCD_URL` when possible.
   */
  host?: string;
}

export interface ResolvedGocdTarget {
  baseUrl: string;
  host: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

/** Resolve a GoCD host from an absolute base URL. */
export function hostFromBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid GoCD base URL: ${baseUrl}`);
  }
  if (url.protocol !== "https:") {
    throw new Error("GoCD base URL must use https");
  }
  return url.host;
}

/** Resolve the absolute request URL for one GoCD API path. */
export function resolveGocdApiUrl(baseUrl: string, path: string): string {
  if (!path.startsWith("/go/")) {
    throw new Error("GoCD API paths must start with /go/");
  }
  return `${trimTrailingSlash(baseUrl)}${path}`;
}

/**
 * Resolve the GoCD target for one tool call.
 * Prefer explicit tool input, then plugin options, then `GOCD_URL`.
 */
export function resolveGocdTarget(input: {
  baseUrl?: string;
  options?: GocdPluginOptions;
}): ResolvedGocdTarget {
  const baseUrl = trimTrailingSlash(
    (
      input.baseUrl ??
      input.options?.baseUrl ??
      process.env.GOCD_URL ??
      ""
    ).trim(),
  );
  if (!baseUrl) {
    throw new Error(
      "GoCD base URL is required. Pass baseUrl, configure gocdPlugin({ baseUrl }), or set GOCD_URL.",
    );
  }
  const host = (input.options?.host ?? hostFromBaseUrl(baseUrl)).trim();
  if (!host) {
    throw new Error("GoCD host is required");
  }
  return { baseUrl, host };
}

/** Input fields that identify one exact GoCD stage run, shared across tools. */
export const stageRunInputShape = {
  baseUrl: z
    .string()
    .trim()
    .url()
    .optional()
    .describe(
      "Optional absolute GoCD base URL. Defaults to gocdPlugin({ baseUrl }) or GOCD_URL.",
    ),
  pipeline: z.string().trim().min(1).describe("Exact GoCD pipeline name."),
  pipelineCounter: z
    .number()
    .int()
    .min(1)
    .describe("Pipeline run counter (integer)."),
  stage: z.string().trim().min(1).describe("Exact stage name."),
  stageCounter: z
    .number()
    .int()
    .min(1)
    .describe("Stage run counter (integer)."),
};

/** Encode the `pipeline/counter/stage/counter` path segment shared by GoCD URLs. */
export function stageRunPath(ref: {
  pipeline: string;
  pipelineCounter: number;
  stage: string;
  stageCounter: number;
}): string {
  return (
    `${encodeURIComponent(ref.pipeline)}/${ref.pipelineCounter}` +
    `/${encodeURIComponent(ref.stage)}/${ref.stageCounter}`
  );
}
