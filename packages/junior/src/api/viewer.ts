import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { User } from "@sentry/junior-plugin-api";
import { throwApiError } from "./http";
import type { AuthenticatedJuniorApiEnv, JuniorApiEnv } from "./route";

/** Read the optional authenticated Junior user from one request. */
export function getViewer(context: Context<JuniorApiEnv>): User | undefined {
  return context.get("viewer");
}

/** Require a viewer and refine later Hono handlers to authenticated context. */
export const requireViewer = createMiddleware<AuthenticatedJuniorApiEnv>(
  async (context, next) => {
    if (!context.get("viewer")) {
      throwApiError(401, "Authentication required.");
    }
    await next();
  },
);
