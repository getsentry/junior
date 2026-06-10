export type AuthorizationPauseKind = "mcp" | "plugin";
export type AuthorizationPauseDisposition = "link_already_sent" | "link_sent";
export type AuthorizationFlowMode = "interactive" | "disabled";

/**
 * Runtime-owned signal that the current turn must park until the user
 * completes an external authorization step.
 */
export class AuthorizationPauseError extends Error {
  readonly disposition: AuthorizationPauseDisposition;
  readonly kind: AuthorizationPauseKind;
  readonly provider: string;
  readonly providerDisplayName: string;

  constructor(
    kind: AuthorizationPauseKind,
    provider: string,
    providerDisplayName: string,
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
    this.providerDisplayName = providerDisplayName;
  }
}

/** Error indicating this turn cannot start an external authorization flow. */
export class AuthorizationFlowDisabledError extends Error {
  readonly kind: AuthorizationPauseKind;
  readonly provider: string;

  constructor(kind: AuthorizationPauseKind, provider: string) {
    super(
      `Authorization is required for ${provider}, but this turn cannot start an authorization flow.`,
    );
    this.name = "AuthorizationFlowDisabledError";
    this.kind = kind;
    this.provider = provider;
  }
}
