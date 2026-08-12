import type { ZodType } from "zod";

/** An authenticated dashboard request rejected by the product API. */
export class DashboardApiError extends Error {
  readonly status: number;

  constructor(path: string, status: number) {
    super(`${path} returned ${status}`);
    this.status = status;
  }
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
  if (!response.ok) throw new DashboardApiError(path, response.status);
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
  if (!response.ok) throw new DashboardApiError(path, response.status);
  return schema.parse(await response.json());
}

/** Delete one authenticated dashboard resource. */
export async function deleteDashboardResource(path: string): Promise<void> {
  const response = await fetch(path, {
    credentials: "same-origin",
    method: "DELETE",
  });
  if (response.status === 401) restartDashboardSignIn();
  if (!response.ok) throw new DashboardApiError(path, response.status);
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
  if (!response.ok) throw new DashboardApiError(path, response.status);
  return schema.parse(await response.json());
}

/** Fetch one authenticated dashboard JSON resource and validate its response. */
export async function fetchDashboardJson<T>(
  schema: ZodType<T>,
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (response.status === 401) {
    restartDashboardSignIn();
    throw new DashboardApiError(path, response.status);
  }
  if (!response.ok) throw new DashboardApiError(path, response.status);
  return schema.parse(await response.json());
}
