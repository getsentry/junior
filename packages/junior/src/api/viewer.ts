import type { Context } from "hono";
import type { User } from "@sentry/junior-plugin-api";
import { throwApiError } from "./http";
import type { JuniorApiEnv } from "./route";

/** Read the optional authenticated Junior user from one request. */
export function getViewer(context: Context<JuniorApiEnv>): User | undefined {
  return context.get("viewer");
}

/** Require the authenticated Junior user or stop with 401. */
export function requireViewer(context: Context<JuniorApiEnv>): User {
  const viewer = getViewer(context);
  if (!viewer) throwApiError(401, "Authentication required.");
  return viewer;
}
