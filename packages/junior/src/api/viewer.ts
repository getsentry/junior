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
