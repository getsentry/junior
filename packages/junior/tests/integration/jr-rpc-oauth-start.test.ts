import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatPostEphemeralOk } from "../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiResponse,
} from "../msw/handlers/slack-api";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();
const EXAMPLE_APP_DIR = path.resolve(
  ORIGINAL_CWD,
  "..",
  "..",
  "apps",
  "example",
);

function makeRuntime() {
  const broker = {
    issue: async () => {
      throw new Error(
        "credential issuance should not run in oauth-start tests",
      );
    },
  };
  return broker;
}

function extractSlackLink(text: string): URL {
  const match = text.match(/^<([^|>]+)\|/);
  if (!match?.[1]) {
    throw new Error(`Expected Slack link markup, got: ${text}`);
  }
  return new URL(match[1]);
}

describe("jr-rpc oauth-start integration", () => {
  beforeEach(async () => {
    process.chdir(EXAMPLE_APP_DIR);
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_STATE_ADAPTER: "memory",
      JUNIOR_PLUGIN_PACKAGES: JSON.stringify(["@sentry/junior-sentry"]),
      JUNIOR_BASE_URL: "https://junior.example.com",
      SENTRY_CLIENT_ID: "sentry-client-id",
    };
    vi.resetModules();
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
    vi.resetModules();
    process.chdir(ORIGINAL_CWD);
    process.env = { ...ORIGINAL_ENV };
  });

  it("delivers an in-context Slack authorization link and stores oauth state", async () => {
    const { maybeExecuteJrRpcCustomCommand } =
      await import("@/chat/capabilities/jr-rpc-command");
    const { SkillCapabilityRuntime } =
      await import("@/chat/capabilities/runtime");
    const { getStateAdapter } = await import("@/chat/state/adapter");
    await getStateAdapter().connect();
    queueSlackApiResponse("chat.postEphemeral", {
      body: chatPostEphemeralOk({ messageTs: "1700000000.555" }),
    });
    const runtime = new SkillCapabilityRuntime({
      broker: makeRuntime(),
      requesterId: "U123",
    });

    const result = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc oauth-start sentry",
      {
        capabilityRuntime: runtime,
        activeSkill: null,
        requesterId: "U123",
        channelId: "C123",
        threadTs: "1700000000.001",
      },
    );

    expect(result.handled).toBe(true);
    if (!result.handled) {
      throw new Error("expected jr-rpc command to be handled");
    }

    if (result.result.exit_code !== 0) {
      throw new Error(
        `expected jr-rpc oauth-start success, got stderr: ${result.result.stderr || "<empty>"}`,
      );
    }
    expect(JSON.parse(result.result.stdout)).toMatchObject({
      ok: true,
      private_delivery_sent: true,
    });

    const ephemeralCalls = getCapturedSlackApiCalls("chat.postEphemeral");
    expect(ephemeralCalls).toHaveLength(1);
    expect(ephemeralCalls[0]?.params).toMatchObject({
      channel: "C123",
      user: "U123",
      thread_ts: "1700000000.001",
    });

    const authorizeUrl = extractSlackLink(
      String(ephemeralCalls[0]?.params.text),
    );
    expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(
      "https://sentry.io/oauth/authorize/",
    );
    expect(authorizeUrl.searchParams.get("client_id")).toBe("sentry-client-id");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      "https://junior.example.com/api/oauth/callback/sentry",
    );
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("scope")).toContain("event:read");

    const state = authorizeUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    const stored = await getStateAdapter().get<{
      userId: string;
      provider: string;
      channelId?: string;
      threadTs?: string;
      pendingMessage?: string;
    }>(`oauth-state:${state}`);
    expect(stored).toMatchObject({
      userId: "U123",
      provider: "sentry",
      channelId: "C123",
      threadTs: "1700000000.001",
    });
    expect(stored?.pendingMessage).toBeUndefined();
  });
});
