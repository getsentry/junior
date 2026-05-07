export type AuthorizationPauseKind = "mcp" | "plugin";
export type AuthorizationPauseDisposition = "link_already_sent" | "link_sent";

/**
 * Runtime-owned signal that the current turn must park until the user
 * completes an external authorization step.
 */
export class AuthorizationPauseError extends Error {
  readonly disposition: AuthorizationPauseDisposition;
  readonly kind: AuthorizationPauseKind;
  readonly provider: string;

  constructor(
    kind: AuthorizationPauseKind,
    provider: string,
    disposition: AuthorizationPauseDisposition,
  ) {
    super(
      kind === "mcp"
        ? `MCP authorization started for ${provider}`
        : `Plugin authorization started for ${provider}`,
    );
    this.name =
      kind === "mcp"
        ? "McpAuthorizationPauseError"
        : "PluginAuthorizationPauseError";
    this.disposition = disposition;
    this.kind = kind;
    this.provider = provider;
  }
}
