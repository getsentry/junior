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
  readonly providerDisplayName: string;
  readonly requestText?: string;

  constructor(
    kind: AuthorizationPauseKind,
    provider: string,
    providerDisplayName: string,
    disposition: AuthorizationPauseDisposition,
    requestText?: string,
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
    this.requestText = requestText;
  }
}

/** Error indicating an authorization pause could not be made durable. */
export class AuthPausePersistenceError extends Error {
  constructor(conversationId: string, turnId: string, cause?: unknown) {
    super(
      `Failed to persist auth pause for conversation=${conversationId} turn=${turnId}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "AuthPausePersistenceError";
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
