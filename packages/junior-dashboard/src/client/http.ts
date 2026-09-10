import { ZodError, type ZodType } from "zod";

/** An authenticated dashboard request rejected by the product API. */
export class DashboardApiError extends Error {
  readonly status: number;
  readonly apiError?: string;

  constructor(path: string, status: number, apiError?: string) {
    super(`${path} returned ${status}`);
    this.status = status;
    if (apiError?.trim()) this.apiError = apiError.trim();
  }
}

async function throwDashboardApiError(
  path: string,
  response: Response,
): Promise<never> {
  let apiError: string | undefined;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") apiError = body.error;
  } catch {
    // Keep the status-only fallback when the body is not JSON.
  }
  throw new DashboardApiError(path, response.status, apiError);
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
  const response = await fetch(path, {
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
  const response = await fetch(path, {
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
  const response = await fetch(path, {
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
  const response = await fetch(path, {
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
  const response = await fetch(path, {
    body: JSON.stringify(body),
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    method: "DELETE",
  });
  if (response.status === 401) restartDashboardSignIn();
  if (!response.ok) await throwDashboardApiError(path, response);
  return schema.parse(await response.json());
}

function parseDashboardResponse<T>(schema: ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    const unknownKeys = error.issues.filter(
      (issue) => issue.code === "unrecognized_keys",
    );
    if (
      unknownKeys.length === 0 ||
      unknownKeys.length !== error.issues.length
    ) {
      throw error;
    }
    const compatibleValue = structuredClone(value);
    for (const issue of unknownKeys) {
      let target = compatibleValue;
      for (const segment of issue.path) {
        if (typeof target !== "object" || target === null) throw error;
        target = (target as Record<PropertyKey, unknown>)[segment];
      }
      if (typeof target !== "object" || target === null) throw error;
      for (const key of issue.keys) {
        delete (target as Record<string, unknown>)[key];
      }
    }
    return schema.parse(compatibleValue);
  }
}

/** Fetch one authenticated dashboard JSON resource and validate its response. */
export async function fetchDashboardJson<T>(
  schema: ZodType<T>,
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...(signal ? { signal } : undefined),
  });
  if (response.status === 401) {
    restartDashboardSignIn();
    await throwDashboardApiError(path, response);
  }
  if (!response.ok) await throwDashboardApiError(path, response);
  return parseDashboardResponse(schema, await response.json());
}
