import type { Context, Hono } from "hono";
import type { User } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { jsonResponse } from "./http";
import { requireViewer } from "./viewer";

/** Authenticated viewer fields made available to Junior API route handlers. */
export type JuniorApiVariables = {
  viewer?: User;
};

/** Carry optional viewer state through Junior REST route handlers. */
export type JuniorApiEnv = {
  Variables: JuniorApiVariables;
};

/** Give authenticated route handlers a required canonical viewer. */
export type AuthenticatedJuniorApiEnv = {
  Variables: Omit<JuniorApiVariables, "viewer"> & { viewer: User };
};

type ApiRouteBase<TResponseSchema extends z.ZodType> = {
  method: "delete" | "get" | "patch" | "post";
  path: string;
  responseSchema: TResponseSchema;
};

/** Describe one schema-owned REST endpoint. */
export type ApiRoute<TResponseSchema extends z.ZodType = z.ZodType> =
  | (ApiRouteBase<TResponseSchema> & {
      auth: true;
      handler: (
        context: Context<AuthenticatedJuniorApiEnv>,
      ) => Promise<z.input<TResponseSchema>> | z.input<TResponseSchema>;
    })
  | (ApiRouteBase<TResponseSchema> & {
      auth?: false;
      handler: (
        context: Context<JuniorApiEnv>,
      ) => Promise<z.input<TResponseSchema>> | z.input<TResponseSchema>;
    });

/** Define a REST endpoint while preserving its response-schema type. */
export function defineApiRoute<TResponseSchema extends z.ZodType>(
  route: ApiRoute<TResponseSchema>,
): ApiRoute<TResponseSchema> {
  return route;
}

/** Register schema-owned routes on one Hono application. */
export function registerApiRoutes(
  app: Hono<JuniorApiEnv>,
  routes: readonly ApiRoute[],
): void {
  for (const route of routes) {
    if (route.auth) {
      app.on(route.method, route.path, requireViewer, async (context) =>
        jsonResponse(route.responseSchema, await route.handler(context)),
      );
      continue;
    }
    app.on(route.method, route.path, async (context) =>
      jsonResponse(route.responseSchema, await route.handler(context)),
    );
  }
}
