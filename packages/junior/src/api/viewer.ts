import { createMiddleware } from "hono/factory";
import { throwApiError } from "./http";
import type { AuthenticatedApiEnv } from "./route";

/** Require a viewer and refine later Hono handlers to authenticated context. */
export const requireViewer = createMiddleware<AuthenticatedApiEnv>(
  async (context, next) => {
    if (!context.get("viewer")) {
      throwApiError(401, "Authentication required.");
    }
    await next();
  },
);

/** Require a Junior admin viewer. */
export const requireAdmin = createMiddleware<AuthenticatedApiEnv>(
  async (context, next) => {
    const viewer = context.get("viewer");
    if (!viewer) {
      throwApiError(401, "Authentication required.");
    }
    if (viewer.isAdmin !== true) {
      throwApiError(403, "Only Junior admins can do this.");
    }
    await next();
  },
);
