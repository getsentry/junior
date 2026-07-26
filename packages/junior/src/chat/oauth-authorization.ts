/** User-facing link and guidance for one OAuth authorization attempt. */
export interface OAuthAuthorizationRequest {
  authorizationUrl: string;
  completionText: string;
  label: string;
}

/** Surface-owned capabilities for creating and presenting OAuth authorization. */
export interface OAuthAuthorization {
  createState: () => Promise<string>;
  deliver: (request: OAuthAuthorizationRequest) => void | Promise<void>;
}

/** Build the stable event identity shared by authorization request and completion. */
export function authorizationId(args: {
  kind: "mcp" | "plugin";
  provider: string;
  sessionId: string;
}): string {
  return `${args.sessionId}:${args.kind}:${args.provider}`;
}
