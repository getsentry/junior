import { Hono } from "hono";
import type { ApiRoute } from "../route";
import { conversationArchiveRoute } from "./archive";
import { conversationDetailRoute } from "./detail";
import { conversationListRoute } from "./list";
import { conversationStatsRoute } from "./stats";
import { conversationSubagentRoute } from "./subagent";

const routes: ApiRoute[] = [
  conversationListRoute,
  conversationStatsRoute,
  conversationArchiveRoute,
  conversationDetailRoute,
  conversationSubagentRoute,
];

/** Create the HTTP routes owned by the conversations API. */
export function createConversationRoutes(): Hono {
  const app = new Hono();
  for (const route of routes) app.on(route.method, route.path, route.handler);
  return app;
}
