import { http, HttpResponse } from "msw";

const MCP_CLIENT_ORIGIN = "https://mcp-client.example.test";
/** A Client ID Metadata Document that Junior accepts. */
export const MCP_CLIENT_ID = `${MCP_CLIENT_ORIGIN}/client.json`;
/** A document whose `client_id` names another URL. */
export const MCP_MISMATCHED_CLIENT_ID = `${MCP_CLIENT_ORIGIN}/mismatched.json`;
export const MCP_CLIENT_NAME = "Test MCP Client";
/** Registered loopback callback. Any port matches it. */
export const MCP_CLIENT_REDIRECT_URI = "http://127.0.0.1/callback";

export const mcpClientMetadataHandlers = [
  http.get(MCP_CLIENT_ID, () =>
    HttpResponse.json({
      client_id: MCP_CLIENT_ID,
      client_name: MCP_CLIENT_NAME,
      redirect_uris: [MCP_CLIENT_REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    }),
  ),
  http.get(MCP_MISMATCHED_CLIENT_ID, () =>
    HttpResponse.json({
      client_id: MCP_CLIENT_ID,
      client_name: MCP_CLIENT_NAME,
      redirect_uris: [MCP_CLIENT_REDIRECT_URI],
    }),
  ),
];
