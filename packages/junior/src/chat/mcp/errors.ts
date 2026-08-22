import type { ConversationPrivacy } from "@/chat/conversation-privacy";

export type McpProviderErrorPhase =
  | "connect"
  | "list_tools"
  | "call_tool"
  | "close"
  | "oauth_callback";

export interface McpProviderErrorDetails {
  phase: McpProviderErrorPhase;
  provider: string;
  missingSession?: boolean;
  resourceHost?: string;
  status?: number;
}

/** Safe failure at an MCP network or OAuth boundary. */
export class McpProviderError extends Error {
  readonly phase: McpProviderErrorPhase;
  readonly provider: string;
  readonly missingSession?: boolean;
  readonly resourceHost?: string;
  readonly status?: number;

  constructor(details: McpProviderErrorDetails) {
    super(`MCP provider ${details.phase.replace("_", " ")} failed`);
    this.name = "McpProviderError";
    this.phase = details.phase;
    this.provider = details.provider;
    this.missingSession = details.missingSession;
    this.resourceHost = details.resourceHost;
    this.status = details.status;
  }
}

function providerStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const value = error as { code?: unknown; status?: unknown };
  const status =
    typeof value.status === "number"
      ? value.status
      : typeof value.code === "number"
        ? value.code
        : undefined;
  return status !== undefined && status >= 100 && status <= 599
    ? status
    : undefined;
}

/** Replace an external MCP failure without retaining its provider-controlled cause. */
export function toMcpProviderError(
  error: unknown,
  details: McpProviderErrorDetails,
): McpProviderError {
  if (error instanceof McpProviderError) {
    return error;
  }
  return new McpProviderError({
    ...details,
    status: details.status ?? providerStatus(error),
  });
}

/** Return safe MCP provider fields for logs and spans. */
export function getMcpProviderErrorAttributes(
  error: unknown,
): Record<string, string | number> {
  if (!(error instanceof McpProviderError)) {
    return {};
  }
  return {
    "app.credential.provider": error.provider,
    "app.mcp.error.phase": error.phase,
    ...(error.status !== undefined
      ? { "http.response.status_code": error.status }
      : undefined),
    ...(error.resourceHost ? { "server.address": error.resourceHost } : undefined),
  };
}

/** Thrown when an MCP failure should be returned as a model-visible tool error. */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolError";
  }
}

/** Return the OpenTelemetry error.type value for MCP-aware tool failures. */
export function getMcpAwareErrorType(error: unknown, fallback: string): string {
  if (error instanceof McpToolError) {
    return "tool_error";
  }
  if (error instanceof McpProviderError) {
    return "mcp_provider_error";
  }
  return error instanceof Error ? error.name : fallback;
}

/** Return the display-safe error message for MCP-aware tool failures. */
export function getMcpAwareErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Return an error message safe for logs and span attributes. */
export function getMcpAwareTelemetryMessage(
  error: unknown,
  _privacy: ConversationPrivacy | undefined,
): string {
  if (error instanceof McpToolError) {
    return "MCP tool call failed";
  }
  if (error instanceof McpProviderError) {
    return error.message;
  }
  return getMcpAwareErrorMessage(error);
}
