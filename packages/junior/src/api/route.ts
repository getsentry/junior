import type { User } from "@sentry/junior-plugin-api";

/** Authenticated viewer fields made available to Junior API route handlers. */
export type JuniorApiVariables = {
  viewer?: User;
};

/** Carry optional viewer state through Junior REST route handlers. */
export type JuniorApiEnv = {
  Variables: JuniorApiVariables;
};

/** Give authenticated route handlers a required canonical viewer. */
export type AuthenticatedApiEnv = {
  Variables: Omit<JuniorApiVariables, "viewer"> & { viewer: User };
};
