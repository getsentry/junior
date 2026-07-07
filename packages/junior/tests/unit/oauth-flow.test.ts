import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { postSlackEphemeralMessageMock } = vi.hoisted(() => ({
  postSlackEphemeralMessageMock: vi.fn(),
}));

vi.mock("@/chat/plugins/catalog-runtime", () => ({
  pluginCatalogRuntime: {
    getDisplayName: (provider: string) =>
      provider === "example" ? "Example" : undefined,
    getOAuthConfig: (provider: string) =>
      provider === "example"
        ? {
            clientIdEnv: "EXAMPLE_CLIENT_ID",
            clientSecretEnv: "EXAMPLE_CLIENT_SECRET",
            authorizeEndpoint: "https://api.example.com/oauth/authorize",
            authorizeParams: {
              audience: "workspace",
            },
            callbackPath: "/api/oauth/callback/example",
            scope: "read write",
            tokenEndpoint: "https://api.example.com/oauth/token",
          }
        : undefined,
  },
}));

vi.mock("@/chat/slack/client", () => ({
  getSlackClient: () => ({}),
  isDmChannel: () => false,
  withSlackRetries: vi.fn(),
}));

vi.mock("@/chat/slack/outbound", () => ({
  postSlackEphemeralMessage: postSlackEphemeralMessageMock,
  postSlackMessage: vi.fn(),
}));

import { startOAuthFlow } from "@/chat/oauth-flow";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";

const ORIGINAL_ENV = { ...process.env };

describe("startOAuthFlow", () => {
  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      EXAMPLE_CLIENT_ID: "example-client-id",
      JUNIOR_BASE_URL: "https://junior.example.com",
      JUNIOR_STATE_ADAPTER: "memory",
    };
    postSlackEphemeralMessageMock.mockReset();
    postSlackEphemeralMessageMock.mockResolvedValue({});
    await disconnectStateAdapter();
    await getStateAdapter().connect();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    process.env = { ...ORIGINAL_ENV };
  });

  it("escapes the delivered Slack authorization link URL", async () => {
    const result = await startOAuthFlow("example", {
      requesterId: "U123",
      channelId: "C123",
      threadTs: "1700000000.000000",
    });

    expect(result).toEqual({ ok: true, delivery: "in_context" });
    expect(postSlackEphemeralMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C123",
        threadTs: "1700000000.000000",
        userId: "U123",
        text: expect.stringContaining(
          "https://api.example.com/oauth/authorize?client_id=example-client-id&amp;",
        ),
      }),
    );
    expect(postSlackEphemeralMessageMock.mock.calls[0]?.[0].text).toContain(
      "&amp;redirect_uri=https%3A%2F%2Fjunior.example.com%2Fapi%2Foauth%2Fcallback%2Fexample&amp;",
    );
    expect(postSlackEphemeralMessageMock.mock.calls[0]?.[0].text).toContain(
      "&amp;audience=workspace|Click here to link your Example account>",
    );
  });
});
