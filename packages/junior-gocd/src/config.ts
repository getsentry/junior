/** GoCD connection settings supplied by the app. */

export interface GocdPluginOptions {
  /**
   * Optional default GoCD base URL, for example `https://gocd.example.com`.
   * When omitted, tools require `GOCD_URL`.
   */
  baseUrl?: string;
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
    throw new Error(
      "GoCD base URL cannot include credentials, a path, a query, or a fragment",
    );
  }
  return url;
}

/** Return the hostname from a valid GoCD base URL. */
export function hostnameFromBaseUrl(baseUrl: string): string {
  return parseBaseUrl(baseUrl).hostname;
}

/** Resolve the absolute request URL for one GoCD API path. */
export function resolveGocdApiUrl(baseUrl: string, path: string): string {
  if (!path.startsWith("/go/")) {
    throw new Error("GoCD API paths must start with /go/");
  }
  return `${parseBaseUrl(baseUrl).origin}${path}`;
}

/** Return the configured GoCD base URL. */
export function resolveGocdBaseUrl(options: GocdPluginOptions = {}): string {
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
  return parseBaseUrl(configuredBaseUrl).origin;
}
