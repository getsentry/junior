import { Hono } from "hono";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import {
  disconnectConnection,
  isConnectableProvider,
  listConnections,
  startConnection,
} from "@/chat/credentials/connections";
import { webActorFromUser } from "@/chat/conversations/web-input";
import { logInfo } from "@/chat/logging";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  connectionListSchema,
  connectionParamsSchema,
  disconnectConnectionResponseSchema,
  startConnectionResponseSchema,
} from "../schema/connection";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";

/**
 * Create authenticated routes that list, connect, and disconnect the viewer's
 * plugin accounts. Connections belong to the viewer's User id, which is the
 * web Actor id and the credential subject for the viewer's web Conversations.
 */
export function createConnectionRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.get("/", requireViewer, async (context) => {
    return jsonResponse(connectionListSchema, {
      connections: await listConnections(
        context.get("viewer").id,
        createUserTokenStore(),
      ),
    });
  });

  app.post(
    "/:provider",
    requireViewer,
    validateRequest("param", connectionParamsSchema, "Invalid provider."),
    async (context) => {
      const { provider } = context.req.valid("param");
      if (!isConnectableProvider(provider)) {
        throwApiError(404, "Connection not found.");
      }
      const result = await startConnection(
        provider,
        webActorFromUser(context.get("viewer")),
      );
      if (!result.ok) {
        throwApiError(503, result.error);
      }
      return jsonResponse(startConnectionResponseSchema, {
        authorizationUrl: result.authorizationUrl,
      });
    },
  );

  app.delete(
    "/:provider",
    requireViewer,
    validateRequest("param", connectionParamsSchema, "Invalid provider."),
    async (context) => {
      const { provider } = context.req.valid("param");
      if (!isConnectableProvider(provider)) {
        throwApiError(404, "Connection not found.");
      }
      await disconnectConnection(
        context.get("viewer").id,
        provider,
        createUserTokenStore(),
      );
      logInfo("dashboard.credential.unlinked", {
        "app.credential.provider": provider,
      });
      return jsonResponse(disconnectConnectionResponseSchema, {
        disconnected: true as const,
      });
    },
  );

  return app;
}
