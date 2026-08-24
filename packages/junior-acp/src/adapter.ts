import type { PluginRouteMethod, User } from "@sentry/junior-plugin-api";
import {
  ACP_AUTHORIZATION_PATH,
  handleAcpAuthorizationPage,
} from "./authorization-page";
import type { ConversationPort } from "./conversations";
import { createAcpHttpHandler } from "./route";
import type { AcpState } from "./state";

interface AcpAdapterContext {
  agentName: string;
  baseURL?: string;
  conversations: ConversationPort;
  reportError(
    error: unknown,
    event: string,
    attributes?: Record<string, unknown>,
  ): void;
  state: AcpState;
  version: string;
}

interface AcpAdapterRoute {
  handler(request: Request): Promise<Response> | Response;
  method: readonly PluginRouteMethod[];
  path: string;
}

interface AcpAuthenticatedRoute {
  handler(request: Request, user: User): Promise<Response> | Response;
  method: readonly PluginRouteMethod[];
  path: string;
}

/** Configure remote ACP as a Junior app adapter. */
export function acpAdapter(): (context: AcpAdapterContext) => {
  authenticatedRoutes: AcpAuthenticatedRoute[];
  routes: AcpAdapterRoute[];
} {
  return (context) => {
    const handleAcpRequest = createAcpHttpHandler({
      baseURL: context.baseURL,
      conversations: context.conversations,
      onError: (error, event, attributes) =>
        context.reportError(error, event, { ...attributes, platform: "acp" }),
      state: context.state,
      version: context.version,
    });

    return {
      authenticatedRoutes: [
        {
          handler: (request, user) =>
            handleAcpAuthorizationPage({
              agentName: context.agentName,
              request,
              state: context.state,
              user,
            }),
          method: ["GET", "POST"],
          path: ACP_AUTHORIZATION_PATH,
        },
      ],
      routes: [
        {
          handler: handleAcpRequest,
          method: ["GET", "POST", "DELETE"],
          path: "/api/acp",
        },
      ],
    };
  };
}
