/** Host-configurable GoCD connection settings. */

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
