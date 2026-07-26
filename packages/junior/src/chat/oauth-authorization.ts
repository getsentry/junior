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
