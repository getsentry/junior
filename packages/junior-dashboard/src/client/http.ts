import type { ZodType } from "zod";
import { recordDashboardServerVersion } from "./dashboard-version";
import { readResponseJson } from "./sentry";

declare global {
  interface Window {
    __JUNIOR_DASHBOARD_EARLY_RESPONSE__?: {
      path: string;
      response: Promise<Response>;
    };
  }
}

// The page shell starts the first read of a Conversation page before this
// module loads (see `conversationOpenScript`). The first request for the same
// path takes it, once, so later reads see fresh data.
function takeEarlyResponse(path: string): Promise<Response> | undefined {
  if (typeof window === "undefined") return undefined;
  const early = window.__JUNIOR_DASHBOARD_EARLY_RESPONSE__;
  if (early?.path !== path) return undefined;
  delete window.__JUNIOR_DASHBOARD_EARLY_RESPONSE__;
  return early.response.then((response) => {
    recordDashboardServerVersion(response);
    return response;
  });
}

/** An authenticated dashboard request rejected by the product API. */
export class DashboardApiError extends Error {
  readonly status: number;
  readonly fields?: Record<string, string[]>;
  readonly code?: string;
  readonly apiError?: string;

  constructor(
    path: string,
    status: number,
    apiError?: string,
    detail?: { fields?: Record<string, string[]>; code?: string },
  ) {
    super(`${path} returned ${status}`);
    this.status = status;
    this.fields = detail?.fields;
    this.code = detail?.code;
    if (apiError?.trim()) this.apiError = apiError.trim();
  }
}

async function throwDashboardApiError(
  path: string,
  response: Response,
): Promise<never> {
  let apiError: string | undefined;
  let fields: Record<string, string[]> | undefined;
  let code: string | undefined;
  try {
    const body = (await response.json()) as {
      error?: unknown;
      code?: unknown;
      fields?: unknown;
    };
    if (typeof body.error === "string") apiError = body.error;
    if (typeof body.code === "string") code = body.code;
    if (body.fields && typeof body.fields === "object") {
      fields = Object.fromEntries(
        Object.entries(body.fields).filter(
          (entry): entry is [string, string[]] =>
            Array.isArray(entry[1]) &&
            entry[1].every((value) => typeof value === "string"),
        ),
      );
    }
  } catch {
    // Keep the status-only fallback when the body is not JSON.
  }
  throw new DashboardApiError(path, response.status, apiError, {
    fields,
    code,
  });
}

function restartDashboardSignIn(): void {
  if (typeof window === "undefined") {
    return;
  }

  const basePath = window.__JUNIOR_DASHBOARD_BASE_PATH__ ?? "/";
  const loginPath = basePath === "/" ? "/auth/login" : `${basePath}/auth/login`;
  if (window.location.pathname !== loginPath) {
    const returnPath = `${window.location.pathname}${
      window.location.search || ""
    }`;
    const loginParams = new URLSearchParams();
    if (returnPath !== "/") {
      loginParams.set("next", returnPath);
    }
    const loginSearch = loginParams.toString();
    window.location.assign(
      loginSearch ? `${loginPath}?${loginSearch}` : loginPath,
    );
  }
}

/** Send one authenticated PATCH request and validate its response. */
export async function patch<T>(
  schema: ZodType<T>,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await fetchDashboard(path, {
    body: JSON.stringify(body),
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  if (response.status === 401) restartDashboardSignIn();
  if (!response.ok) await throwDashboardApiError(path, response);
  return readResponseJson(response, schema);
}

/** Send one authenticated POST request and validate its response. */
export async function post<T>(
  schema: ZodType<T>,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await fetchDashboard(path, {
    body: JSON.stringify(body),
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (response.status === 401) restartDashboardSignIn();
  if (!response.ok) await throwDashboardApiError(path, response);
  return readResponseJson(response, schema);
}

/** Send one authenticated PUT request and validate its response. */
export async function put<T>(
  schema: ZodType<T>,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await fetchDashboard(path, {
    body: JSON.stringify(body),
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
  if (response.status === 401) restartDashboardSignIn();
  if (!response.ok) await throwDashboardApiError(path, response);
  return readResponseJson(response, schema);
}

/** Delete one authenticated dashboard resource. */
export async function deleteDashboardResource(path: string): Promise<void> {
  const response = await fetchDashboard(path, {
    credentials: "same-origin",
    method: "DELETE",
  });
  if (response.status === 401) restartDashboardSignIn();
  if (!response.ok) await throwDashboardApiError(path, response);
}

/** Send one authenticated DELETE request with JSON body and validate its response. */
export async function del<T>(
  schema: ZodType<T>,
  path: string,
  body: unknown = {},
): Promise<T> {
  const response = await fetchDashboard(path, {
    body: JSON.stringify(body),
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    method: "DELETE",
  });
  if (response.status === 401) restartDashboardSignIn();
  if (!response.ok) await throwDashboardApiError(path, response);
  return readResponseJson(response, schema);
}

async function fetchDashboard(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  recordDashboardServerVersion(response);
  return response;
}

/**
 * Check that an authenticated dashboard file can be downloaded, without
 * downloading it, and throw the server's reason when it cannot. A HEAD
 * response has no body, so a refused check asks again with GET to read the
 * error. That GET fails before it sends file bytes.
 */
export async function checkDashboardDownload(path: string): Promise<void> {
  const head = await fetchDashboard(path, {
    credentials: "same-origin",
    method: "HEAD",
  });
  if (head.status === 401) restartDashboardSignIn();
  if (head.ok) return;
  const response = await fetchDashboard(path, { credentials: "same-origin" });
  if (response.ok) {
    // The file became readable after the check. Do not read it here.
    await response.body?.cancel();
    return;
  }
  await throwDashboardApiError(path, response);
}

/**
 * Read at most `maxBytes` from the start of an authenticated dashboard file.
 * It asks for one byte range, so a large file does not download whole.
 */
export async function readDashboardBytes(
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetchDashboard(path, {
    credentials: "same-origin",
    headers: { range: `bytes=0-${maxBytes - 1}` },
    ...(signal ? { signal } : undefined),
  });
  if (response.status === 401) restartDashboardSignIn();
  if (!response.ok) await throwDashboardApiError(path, response);
  // HTTP lets a server ignore the range and send the whole file.
  return new Uint8Array(await response.arrayBuffer()).subarray(0, maxBytes);
}

/** Fetch one authenticated dashboard JSON resource and validate its response. */
export async function fetchDashboardJson<T>(
  schema: ZodType<T>,
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await readDashboardResponse(path, signal);
  return readResponseJson(response, schema);
}

/** Read an authenticated response, allowing 304 only for explicit validator headers. */
export async function readDashboardResponse(
  path: string,
  signal?: AbortSignal,
  validator?: Record<string, string>,
): Promise<Response> {
  // A read with a validator has a cached copy, so it is never the first.
  const early = validator ? undefined : takeEarlyResponse(path);
  const response = await (early ??
    fetchDashboard(path, {
      credentials: "same-origin",
      ...(signal ? { signal } : undefined),
      ...(validator
        ? { cache: "no-store" as const, headers: validator }
        : undefined),
    }));
  if (response.status === 401) restartDashboardSignIn();
  if (!response.ok && !(validator && response.status === 304)) {
    await throwDashboardApiError(path, response);
  }
  return response;
}
