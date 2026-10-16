import { Hono } from "hono";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import {
  disconnectConnection,
  isConnectableProvider,
  listConnections,
  startConnection,
} from "@/chat/credentials/connections";
import { webActorFromEmail } from "@/chat/conversations/web-input";
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
 * plugin accounts. Connections belong to the viewer's web actor, which is the
 * credential subject for the viewer's web Conversations.
 */
export function createConnectionRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.get("/", requireViewer, async (context) => {
    const actor = webActorFromEmail(context.get("viewer").email);
    return jsonResponse(connectionListSchema, {
      connections: await listConnections(actor.userId, createUserTokenStore()),
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
      const viewer = context.get("viewer");
      const result = await startConnection(
        provider,
        webActorFromEmail(viewer.email, {
          ...(viewer.displayName
            ? { fullName: viewer.displayName }
            : undefined),
        }),
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
      const actor = webActorFromEmail(context.get("viewer").email);
      await disconnectConnection(
        actor.userId,
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
