/** Host-configurable GoCD connection settings. */

export interface GocdPluginOptions {
  /**
   * Optional default GoCD base URL, for example `https://gocd.example.com`.
   * When omitted, tools require `GOCD_URL`.
   */
  baseUrl?: string;
}

export interface ResolvedGocdTarget {
  baseUrl: string;
  host: string;
}

function parseBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid GoCD base URL: ${baseUrl}`);
  }
  if (url.protocol !== "https:") {
    throw new Error("GoCD base URL must use https");
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("GoCD base URL must be an origin without a path or query");
  }
  return url;
}

/** Resolve a GoCD host from an absolute base URL. */
export function hostFromBaseUrl(baseUrl: string): string {
  return parseBaseUrl(baseUrl).hostname;
}

/** Resolve the absolute request URL for one GoCD API path. */
export function resolveGocdApiUrl(baseUrl: string, path: string): string {
  if (!path.startsWith("/go/")) {
    throw new Error("GoCD API paths must start with /go/");
  }
  return `${parseBaseUrl(baseUrl).origin}${path}`;
}

/**
 * Resolve the GoCD target from plugin options or `GOCD_URL`.
 */
export function resolveGocdTarget(
  options: GocdPluginOptions = {},
): ResolvedGocdTarget {
  const configuredBaseUrl = (
    options.baseUrl ??
    process.env.GOCD_URL ??
    ""
  ).trim();
  if (!configuredBaseUrl) {
    throw new Error(
      "GoCD base URL is required. Configure gocdPlugin({ baseUrl }) or set GOCD_URL.",
    );
  }
  const url = parseBaseUrl(configuredBaseUrl);
  return { baseUrl: url.origin, host: url.hostname };
}
