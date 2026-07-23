import type { Handler } from "hono";

/** Authenticated viewer fields made available to Junior API route handlers. */
export type JuniorApiVariables = {
  verifiedViewerEmail?: string;
};

/** Carry authenticated viewer state through Junior REST route handlers. */
export type JuniorApiEnv = {
  Variables: JuniorApiVariables;
};

/** Describe one API route with a uniform Hono handler contract. */
export type ApiRoute = {
  handler: Handler<JuniorApiEnv>;
  method: "get" | "patch";
  path: string;
};
