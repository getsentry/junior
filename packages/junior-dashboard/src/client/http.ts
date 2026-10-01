import type { ZodType } from "zod";
import { recordDashboardServerVersion } from "./dashboard-version";

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
  return schema.parse(await response.json());
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
  return schema.parse(await response.json());
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
  return schema.parse(await response.json());
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
  return schema.parse(await response.json());
}

async function fetchDashboard(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  recordDashboardServerVersion(response);
  return response;
}

/** Fetch one authenticated dashboard JSON resource and validate its response. */
export async function fetchDashboardJson<T>(
  schema: ZodType<T>,
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await readDashboardResponse(path, signal);
  return schema.parse(await response.json());
}

/** Read an authenticated response, allowing 304 only for an explicit validator. */
export async function readDashboardResponse(
  path: string,
  signal?: AbortSignal,
  etag?: string,
): Promise<Response> {
  const response = await fetchDashboard(path, {
    credentials: "same-origin",
    ...(signal ? { signal } : undefined),
    ...(etag
      ? { cache: "no-store" as const, headers: { "if-none-match": etag } }
      : undefined),
  });
  if (response.status === 401) restartDashboardSignIn();
  if (!response.ok && !(etag && response.status === 304)) {
    await throwDashboardApiError(path, response);
  }
  return response;
}
