/**
 * MCP calls as the viewer of a link card or its image.
 *
 * Only the viewer's own stored MCP login is used, never a service account
 * or another person's login. A read never asks the viewer to sign in and
 * never deletes their login: only the shared refresh lock saves the tokens
 * of a refresh. It calls only tools that the plugin allows and that the
 * provider marks read-only.
 */
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  PluginMcpContent,
  PluginViewerMcp,
} from "@sentry/junior-plugin-api";
import { resolveBaseUrl } from "@/chat/oauth-flow";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import type { PluginDefinition } from "@/chat/plugins/types";
import { getMcpStoredOAuthCredentials } from "./auth-store";
import { McpAuthorizationRequiredError, PluginMcpClient } from "./client";
import { getMcpOAuthCallbackPath } from "./oauth";
import type { McpLoginOwner } from "./token-refresh";
import {
  createClientMetadata,
  readMcpClientInformation,
} from "./oauth-provider";

function viewerAuthProvider(
  plugin: PluginDefinition,
  userId: string,
): OAuthClientProvider & { mcpLoginOwner(): Promise<McpLoginOwner> } {
  const provider = plugin.manifest.name;
  const baseUrl = resolveBaseUrl();
  if (!baseUrl) {
    throw new Error(
      "Cannot determine base URL (set JUNIOR_BASE_URL or deploy to Vercel)",
    );
  }
  // The SDK refreshes tokens only for a client with the registered redirect.
  const callbackUrl = `${baseUrl}${getMcpOAuthCallbackPath(provider)}`;
  return {
    redirectUrl: callbackUrl,
    clientMetadata: createClientMetadata(callbackUrl),
    clientInformation: async () =>
      await readMcpClientInformation({
        callbackUrl,
        oauthClient: plugin.manifest.mcp?.oauthClient,
        provider,
        userId,
      }),
    saveClientInformation: () => {
      throw new Error(`A ${provider} viewer read cannot register a client`);
    },
    tokens: async () =>
      (await getMcpStoredOAuthCredentials(userId, provider))?.tokens,
    // A viewer read gets tokens only from a refresh, and the refresh lock
    // saved them already. Saving again after the lock opens could put back
    // a refresh token that a later refresh retired.
    saveTokens: () => undefined,
    discoveryState: async () =>
      (await getMcpStoredOAuthCredentials(userId, provider))?.discoveryState,
    // A Turn owns the login: a viewer read keeps what it finds.
    invalidateCredentials: () => undefined,
    // A sign-in needs the viewer in a Turn. The SDK then reports that the
    // read is unauthorized.
    redirectToAuthorization: () => undefined,
    saveCodeVerifier: () => undefined,
    codeVerifier: () => {
      throw new Error(`A ${provider} viewer read has no sign-in`);
    },
    mcpLoginOwner: async () => ({ provider, userId }),
  };
}

function providerContent(
  content: ReadonlyArray<{ type: string }>,
): PluginMcpContent[] {
  return content.flatMap((part): PluginMcpContent[] => {
    if (part.type === "text" && "text" in part) {
      return [{ type: "text", text: String(part.text) }];
    }
    if (part.type === "image" && "data" in part && "mimeType" in part) {
      return [
        {
          type: "image",
          data: String(part.data),
          mimeType: String(part.mimeType),
        },
      ];
    }
    return [];
  });
}

/**
 * Create read-only MCP access to one plugin's provider as one viewer. The
 * viewer's User id is the subject of their stored MCP login.
 */
export function createViewerMcp(
  provider: string,
  userId: string,
): PluginViewerMcp {
  return {
    async callTool(input) {
      const plugin = pluginCatalogRuntime.getDefinition(provider);
      if (!plugin?.manifest.mcp) {
        throw new Error(`Plugin "${provider}" does not support MCP`);
      }
      const allowedTools = plugin.manifest.mcp.allowedTools;
      if (!allowedTools?.includes(input.name)) {
        throw new Error(
          `Plugin ${provider} does not allow MCP tool ${input.name} for viewer reads`,
        );
      }
      if (!(await getMcpStoredOAuthCredentials(userId, provider))?.tokens) {
        return { status: "not_connected" };
      }
      const client = new PluginMcpClient(plugin, {
        authProvider: viewerAuthProvider(plugin, userId),
      });
      try {
        const tool = (await client.listTools()).find(
          (candidate) => candidate.name === input.name,
        );
        if (tool?.annotations?.readOnlyHint !== true) {
          throw new Error(
            `MCP tool ${provider}/${input.name} is not read-only`,
          );
        }
        const result = await client.callTool(input.name, input.arguments ?? {});
        // A legacy `toolResult` has no content parts.
        const content = Array.isArray(result.content)
          ? providerContent(result.content)
          : [];
        if (result.isError) {
          const message = content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n")
            .trim();
          return {
            status: "error",
            message: message || "MCP tool call failed",
          };
        }
        return {
          status: "success",
          content,
          ...(result.structuredContent !== undefined
            ? { structuredContent: result.structuredContent }
            : undefined),
        };
      } catch (error) {
        if (error instanceof McpAuthorizationRequiredError) {
          return { status: "not_connected" };
        }
        throw error;
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };
}
