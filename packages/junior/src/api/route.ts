import type { Handler } from "hono";

/** Describe one API route with a uniform Hono handler contract. */
export type ApiRoute = {
  handler: Handler;
  method: "get" | "patch";
  path: string;
};
