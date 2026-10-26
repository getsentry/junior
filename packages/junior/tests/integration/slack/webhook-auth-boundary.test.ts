import { createMemoryState } from "@chat-adapter/state-memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { closeDb, getConversationEventStore } from "@/chat/db";
import { setExperimentalFeatures } from "@/chat/experimental";
import { createSignInAuth } from "@/chat/sign-in/auth";
import { handleSlackSignIn } from "@/chat/sign-in/slack";
import { JuniorChat } from "@/chat/ingress/junior-chat";
import { runWithWorkspaceTeamId } from "@/chat/ingress/workspace-membership";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import {
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
  createSlackAdapterFixture,
  handleSlackWebhookAndFlush,
  slackEnvelope,
  slackWebhookRequest,
} from "../../fixtures/conversation-work";
import { createSlackWebhookTestClient } from "../../fixtures/slack/webhook-client";
import { SUITE_EXPERIMENTAL } from "../../fixtures/experimental-setup";
import { createTestMessage } from "../../fixtures/slack-harness";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import { usersInfoOk } from "../../fixtures/slack/factories/api";
import { slackEventsApiEnvelope } from "../../fixtures/slack/factories/events";
import {
  getCapturedSlackApiCalls,
  queueSlackApiResponse,
  queueSlackApiError,
} from "../../msw/handlers/slack-api";
import { mswServer } from "../../msw/server";

const SIGNING_SECRET = "test-signing-secret";

describe("Slack webhook auth boundary", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await closeDb();
  });

  it.each([
    { channel: "C123", eventType: "app_mention" as const, fields: {} },
    { channel: "D123", eventType: "message" as const, fields: {} },
    { channel: "C123", eventType: "message" as const, fields: {} },
    // event.team alone cannot grant membership, even when it matches ingress.
    // https://github.com/slackapi/bolt-python/blob/eddc4766559e5dc623700015c70ea360d076dced/tests/slack_bolt/request/test_internals.py#L1055-L1081
    {
      channel: "C123",
      eventType: "message" as const,
      fields: { team: "T123" },
    },
    // Bolt's external Enterprise mention has a receiving team and an unknown
    // author workspace. Only IDs change here; keep these fields out of defaults.
    // https://github.com/slackapi/bolt-python/blob/eddc4766559e5dc623700015c70ea360d076dced/tests/slack_bolt/request/test_internals.py#L1022-L1053
    {
      channel: "C123",
      eventType: "app_mention" as const,
      fields: { team: "T123", user_team: "E123", source_team: "E123" },
    },
  ])(
    "verifies unresolved authors before accepting $eventType in $channel: $fields",
    async ({ channel, eventType, fields }) => {
      const state = createMemoryState();
      await state.connect();
      const threadTs = "1712345.0001";
      const threadId = `slack:${channel}:${threadTs}`;
      await state.subscribe(threadId);
      const queue = createConversationWorkQueueTestAdapter();
      const adapter = createSlackAdapterFixture();
      const envelope = slackEventsApiEnvelope({
        channel,
        ts: threadTs,
        threadTs,
        eventType,
        user: "U123",
        text:
          eventType === "app_mention"
            ? `<@${adapter.botUserId}> hello`
            : "hello",
      });
      Object.assign(envelope.event, fields);
      const services = {
        getSlackAdapter: () => adapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      };

      vi.useFakeTimers({ toFake: ["Date"] });
      const profile = usersInfoOk({ userId: "U123" });
      queueSlackApiResponse("users.info", {
        body: { ...profile, user: { ...profile.user, team_id: "TEXTERNAL" } },
      });
      const rejected = await handleSlackWebhookAndFlush({
        request: slackWebhookRequest(envelope),
        services,
      });
      expect(rejected.status).toBe(200);
      expect(queue.queuedMessages()).toEqual([]);
      expect(
        await getConversationWorkState({ conversationId: threadId, state }),
      ).toBeUndefined();
      expect(
        (await getConversationEventStore().loadMessageHistory(threadId)).events,
      ).toEqual([]);
      expect(slackApiOutbox.messages()).toEqual([]);
      expect(slackApiOutbox.reactions()).toEqual([]);

      // External users are briefly cached too. Recheck after that entry expires.
      vi.setSystemTime(Date.now() + 30_001);
      queueSlackApiResponse("users.info", {
        body: profile,
      });
      const accepted = await handleSlackWebhookAndFlush({
        request: slackWebhookRequest(envelope),
        services,
      });
      expect(accepted.status).toBe(200);
      expect(queue.queuedMessages()).toHaveLength(1);
      expect(
        getCapturedSlackApiCalls("users.info").at(-1)?.params,
      ).toMatchObject({ user: "U123" });
      await state.disconnect();
    },
  );

  it("uses mention author fields without a lookup and rejects external authors", async () => {
    const state = createMemoryState();
    await state.connect();
    const adapter = createSlackAdapterFixture();
    const queue = createConversationWorkQueueTestAdapter();
    const threadTs = "1712345.0001";
    const threadId = `slack:C123:${threadTs}`;
    await state.subscribe(threadId);
    const services = {
      getSlackAdapter: () => adapter,
      queue,
      runtime: createNoopSlackWebhookRuntime(),
      state,
    };
    // Bolt's mention fixture has different team and user_team values.
    // Change IDs only.
    // https://github.com/slackapi/bolt-python/blob/eddc4766559e5dc623700015c70ea360d076dced/tests/slack_bolt/request/test_internals.py#L717-L744
    for (const [index, team] of ["TEXTERNAL", "T123"].entries()) {
      const envelope = slackEventsApiEnvelope({
        channel: "C123",
        ts: `1712345.000${index + 2}`,
        threadTs,
        text: `<@${adapter.botUserId}> hello`,
      });
      const response = await handleSlackWebhookAndFlush({
        request: slackWebhookRequest({
          ...envelope,
          is_ext_shared_channel: true,
          event: {
            ...envelope.event,
            team: "T123",
            user_team: team,
            source_team: team,
          },
        }),
        services,
      });
      expect(response.status).toBe(200);
      expect(queue.queuedMessages()).toHaveLength(index);
      const work = await getConversationWorkState({
        conversationId: threadId,
        state,
      });
      expect(work !== undefined).toBe(index === 1);
    }
    expect(getCapturedSlackApiCalls("users.info")).toEqual([]);
    await state.disconnect();
  });

  it("shares membership lookups, isolates users and workspaces, and rechecks expired access", async () => {
    const state = createMemoryState();
    await state.connect();
    const adapter = createSlackAdapterFixture();
    const queue = createConversationWorkQueueTestAdapter();
    const services = {
      getSlackAdapter: () => adapter,
      queue,
      runtime: createNoopSlackWebhookRuntime(),
      state,
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.now();
    let sequence = 1;
    const send = async (teamId = "T123", user = "U123", fields = {}) => {
      const envelope = slackEventsApiEnvelope({
        eventType: "message",
        channel: "D123",
        user,
        ts: `1712345.${String(sequence++).padStart(6, "0")}`,
        threadTs: "1712345.000001",
        text: "hello",
      });
      return await handleSlackWebhookAndFlush({
        request: slackWebhookRequest({
          ...envelope,
          team_id: teamId,
          event: { ...envelope.event, ...fields },
        }),
        services,
      });
    };
    queueSlackApiResponse("users.info", {
      body: usersInfoOk({ userId: "U123" }),
      delayMs: 50,
    });
    const responses = await Promise.all([send(), send(), send()]);
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200,
    ]);
    expect(queue.queuedMessages()).toHaveLength(3);
    expect(getCapturedSlackApiCalls("users.info")).toHaveLength(1);

    vi.setSystemTime(startedAt + 4 * 60_000);
    expect((await send()).status).toBe(200);
    expect(queue.queuedMessages()).toHaveLength(4);
    expect(getCapturedSlackApiCalls("users.info")).toHaveLength(1);

    const profile = usersInfoOk({ userId: "UOTHER" });
    queueSlackApiResponse("users.info", {
      body: { ...profile, user: { ...profile.user, team_id: "TEXTERNAL" } },
    });
    expect((await send("T123", "UOTHER")).status).toBe(200);
    expect((await send("TOTHER", "U123")).status).toBe(200);
    expect(queue.queuedMessages()).toHaveLength(4);
    expect(getCapturedSlackApiCalls("users.info")).toHaveLength(3);

    // Cache hits do not renew the five-minute grant. Fail closed on refresh errors.
    vi.setSystemTime(startedAt + 5 * 60_000 + 1);
    queueSlackApiError("users.info", { error: "missing_scope" });
    expect((await send()).status).toBe(503);
    expect(queue.queuedMessages()).toHaveLength(4);
    // Incomplete responses must not renew the expired grant either.
    const incomplete = usersInfoOk({ userId: "U123" });
    queueSlackApiResponse("users.info", {
      body: { ...incomplete, user: { ...incomplete.user, team_id: undefined } },
    });
    expect((await send()).status).toBe(200);
    expect(queue.queuedMessages()).toHaveLength(4);

    // Errors and incomplete responses are not cached; the next lookup can succeed.
    expect((await send()).status).toBe(200);
    expect(queue.queuedMessages()).toHaveLength(5);
    expect(getCapturedSlackApiCalls("users.info")).toHaveLength(6);

    // A signed explicit external author overrides the newly cached grant.
    // user_team is documented in Slack's Enterprise event example.
    expect(
      (await send("T123", "U123", { user_team: "TEXTERNAL" })).status,
    ).toBe(200);
    expect((await send()).status).toBe(200);
    expect(queue.queuedMessages()).toHaveLength(5);
    expect(getCapturedSlackApiCalls("users.info")).toHaveLength(6);
    await state.disconnect();
  });

  it("asks Slack users for a recent Google sign-in shared with the dashboard", async () => {
    setExperimentalFeatures({ ...SUITE_EXPERIMENTAL, "slack-sign-in": true });
    const baseURL = "https://junior.example.com";
    // Two domains, so Google does not limit accounts with `hd`.
    const allowlist = { domains: ["example.com", "example.org"], emails: [] };
    const auth = createSignInAuth({
      agentName: "junior",
      allowlist,
      authPath: "/api/auth",
      baseURL,
      googleClientId: "google-client",
      googleClientSecret: "google-secret",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
    });
    const signIn = { baseURL, maxAgeMs: 7 * 24 * 60 * 60 * 1000 };
    let googleEmail = "";
    let googleVisits = 0;
    mswServer.use(
      http.post("https://oauth2.googleapis.com/token", () => {
        const claims = {
          aud: "google-client",
          email: googleEmail,
          email_verified: true,
          hd: googleEmail.split("@")[1],
          iss: "https://accounts.google.com",
          sub: `google-${googleEmail}`,
        };
        const payload = Buffer.from(JSON.stringify(claims)).toString(
          "base64url",
        );
        return HttpResponse.json({ id_token: `e30.${payload}.sig` });
      }),
    );
    const state = createMemoryState();
    await state.connect();
    const adapter = createSlackAdapterFixture();
    const queue = createConversationWorkQueueTestAdapter();
    const services = {
      getSlackAdapter: () => adapter,
      queue,
      runtime: createNoopSlackWebhookRuntime(),
      signIn,
      state,
    };
    let sequence = 1;
    const send = async () =>
      await handleSlackWebhookAndFlush({
        request: slackWebhookRequest(
          slackEventsApiEnvelope({
            eventType: "message",
            channel: "D123",
            user: "U123",
            ts: `1712345.${String(sequence++).padStart(6, "0")}`,
            threadTs: "1712345.000001",
            text: "hello",
          }),
        ),
        services,
      });
    const sendBlocked = async () => {
      const prompts = getCapturedSlackApiCalls("chat.postMessage").length;
      expect((await send()).status).toBe(200);
      const calls = getCapturedSlackApiCalls("chat.postMessage");
      expect(calls).toHaveLength(prompts + 1);
      expect(calls.at(-1)?.params).toMatchObject({ channel: "D123" });
      return /<([^|>]+)\|/
        .exec(String(calls.at(-1)?.params.text))![1]!
        .replaceAll("&amp;", "&");
    };
    // A browser with one cookie jar. Google signs in as `email`.
    const createBrowser = () => {
      const cookies = new Map<string, string>();
      const request = (url: string) =>
        new Request(url, {
          headers: {
            cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          },
        });
      const route = async (url: URL): Promise<Response> => {
        if (url.origin === "https://accounts.google.com") {
          googleVisits += 1;
          const back = new URL(url.searchParams.get("redirect_uri")!);
          back.searchParams.set("state", url.searchParams.get("state")!);
          back.searchParams.set("code", "google-code");
          return Response.redirect(back, 302);
        }
        if (url.pathname.startsWith("/api/auth/")) {
          return await auth.handler(request(url.toString()));
        }
        if (url.pathname === "/api/sign-in/slack") {
          return await handleSlackSignIn({
            allowlist,
            auth,
            request: request(url.toString()),
            signIn,
            state,
          });
        }
        // Like the dashboard login: use the session, or sign in with Google.
        if (url.pathname === "/auth/login") {
          if (await auth.getSession(request(url.toString()))) {
            return Response.redirect(`${baseURL}/`, 302);
          }
          return await auth.signInWithGoogle(
            request(url.toString()),
            `${baseURL}/`,
          );
        }
        return new Response("dashboard");
      };
      const visit = async (start: string, email: string) => {
        googleEmail = email;
        let url = new URL(start);
        for (;;) {
          const response = await route(url);
          for (const cookie of response.headers.getSetCookie()) {
            const [pair] = cookie.split(";");
            const name = pair!.slice(0, pair!.indexOf("="));
            const value = pair!.slice(pair!.indexOf("=") + 1);
            if (value && !/max-age=0/i.test(cookie)) cookies.set(name, value);
            else cookies.delete(name);
          }
          const location = response.headers.get("location");
          if (!location) return response;
          url = new URL(location, url);
        }
      };
      return Object.assign(visit, { cookies });
    };

    // A dashboard sign-in before the first Slack message counts for Slack.
    const browser = createBrowser();
    const home = await browser(`${baseURL}/auth/login`, "testuser@example.com");
    expect(await home.text()).toBe("dashboard");
    // The session cookie never carries the Google account or its tokens.
    expect([...browser.cookies.keys()].join()).not.toContain("account");
    expect((await send()).status).toBe(200);
    expect(queue.queuedMessages()).toHaveLength(1);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([]);

    // After the max age, Slack asks again.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);

    // Accounts outside the allowlist, or another person's account, fail.
    expect(
      (await createBrowser()(await sendBlocked(), "testuser@contractor.dev"))
        .status,
    ).toBe(403);
    expect(
      (await createBrowser()(await sendBlocked(), "someone@example.com"))
        .status,
    ).toBe(403);
    expect(queue.queuedMessages()).toHaveLength(1);

    // The Slack page signs in the matching account.
    const link = await sendBlocked();
    const visits = googleVisits;
    expect((await browser(link, "testuser@example.com")).status).toBe(200);
    expect(googleVisits).toBe(visits + 1);
    expect((await send()).status).toBe(200);
    expect(queue.queuedMessages()).toHaveLength(2);

    // The dashboard uses the session from the Slack page.
    expect(
      await (await browser(`${baseURL}/auth/login`, "x@example.com")).text(),
    ).toBe("dashboard");
    expect(googleVisits).toBe(visits + 1);
    await state.disconnect();
  });

  it.each(["message", "factory"] as const)(
    "checks membership before SDK routing for a %s",
    async (mode) => {
      const state = createMemoryState();
      const adapter = createSlackAdapterFixture();
      const bot = new JuniorChat({
        userName: "junior",
        adapters: { slack: adapter },
        state,
      });
      const handled: string[] = [];
      bot.onDirectMessage(async (_thread, message) => {
        handled.push(message.text);
      });
      await bot.initialize();
      const client = createSlackWebhookTestClient({
        signingSecret: SIGNING_SECRET,
      });
      const waitUntil = client.waitUntil();
      const threadId = "slack:D123:1712345.0001";

      vi.useFakeTimers({ toFake: ["Date"] });
      for (const [index, teamId] of ["TEXTERNAL", "T123"].entries()) {
        vi.setSystemTime(Date.now() + 30_001);
        const profile = usersInfoOk({ userId: "U123" });
        queueSlackApiResponse("users.info", {
          body: { ...profile, user: { ...profile.user, team_id: teamId } },
        });
        const message = createTestMessage({
          id: `1712345.000${index + 1}`,
          threadId,
          text: teamId,
          author: { userId: "U123" },
          raw: {
            ...slackEventsApiEnvelope({
              eventType: "message",
              channel: "D123",
              user: "U123",
            }).event,
          },
        });
        await runWithWorkspaceTeamId("T123", () =>
          bot.processMessage(
            adapter,
            threadId,
            mode === "factory" ? async () => message : message,
            { waitUntil: waitUntil.fn },
          ),
        );
        await waitUntil.flush();
      }

      expect(handled).toEqual(["T123"]);
      await bot.shutdown();
    },
  );

  it.each([
    { channel: 123 },
    { files: {} },
    { blocks: [{ type: "rich_text", elements: {} }] },
    { attachments: [{ from_url: 123, title: "preview" }] },
    { ts: "not-a-timestamp" },
    { thread_ts: "99999999999999999" },
  ])("rejects malformed signed payloads: %j", async (invalidFields) => {
    const client = createSlackWebhookTestClient({
      signingSecret: SIGNING_SECRET,
    });
    const waitUntil = client.waitUntil();
    const queue = createConversationWorkQueueTestAdapter();
    const adapter = createSlackAdapterFixture();
    const envelope = slackEnvelope({});
    const response = await handleSlackWebhook({
      request: slackWebhookRequest({
        ...envelope,
        event: { ...envelope.event, ...invalidFields },
      }),
      waitUntil: waitUntil.fn,
      services: {
        getSlackAdapter: () => adapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
      },
    });
    expect(response.status).toBe(400);
    expect(queue.sentRecords()).toEqual([]);
    expect(waitUntil.pendingCount()).toBe(0);
    expect(slackApiOutbox.messages()).toEqual([]);
    expect(slackApiOutbox.reactions()).toEqual([]);
  });

  it("preserves rich message fields through validation and durable handoff", async () => {
    const state = createMemoryState();
    const adapter = createSlackAdapterFixture();
    const queue = createConversationWorkQueueTestAdapter();
    const envelope = slackEnvelope({
      eventType: "message",
      channel: "D123",
      threadTs: "1712345.0001",
    });
    const event = {
      ...envelope.event,
      subtype: "file_share",
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_list",
              style: "bullet",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [{ type: "text", text: "nested" }],
                },
              ],
            },
          ],
        },
      ],
      files: [
        {
          id: "F123",
          name: "note.txt",
          mimetype: "text/plain",
          url_private: "https://files.slack.com/note.txt",
        },
      ],
      attachments: [
        {
          from_url: "https://example.com/task",
          title: "Task",
          text: "Details",
          fields: [{ title: "Status", value: "open" }],
        },
      ],
    };
    const response = await handleSlackWebhookAndFlush({
      request: slackWebhookRequest({ ...envelope, event }),
      services: {
        getSlackAdapter: () => adapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });
    expect(response.status).toBe(200);
    expect(queue.queuedMessages()).toHaveLength(1);
    const work = await getConversationWorkState({
      conversationId: "slack:D123:1712345.0001",
      state,
    });
    expect(work?.messages[0]?.input.metadata?.message).toMatchObject({
      raw: event,
      attachments: [{ type: "file", name: "note.txt", mimeType: "text/plain" }],
      links: [
        {
          url: "https://example.com/task",
          title: "Task",
          description: "Details",
        },
      ],
    });
    await state.disconnect();
  });

  it("validates slash commands before replying with configured usage", async () => {
    vi.stubEnv("JUNIOR_SLASH_COMMAND", "/team");
    vi.resetModules();
    const { handleSlackWebhook } = await import("@/chat/ingress/slack-webhook");
    const client = createSlackWebhookTestClient({
      signingSecret: SIGNING_SECRET,
    });
    const state = createMemoryState();
    const adapter = createJuniorSlackAdapter({
      signingSecret: SIGNING_SECRET,
      botToken: "xoxb-test-token",
      botUserId: "U0BOT",
    });
    const queue = createConversationWorkQueueTestAdapter();
    const waitUntil = client.waitUntil();
    const form = {
      command: "/junior",
      text: "help",
      user_id: "U123",
      team_id: "T123",
      channel_id: "C123",
    };
    const services = {
      getSlackAdapter: () => adapter,
      queue,
      runtime: createNoopSlackWebhookRuntime(),
      state,
    };
    for (const invalid of [
      { team_id: "" },
      { channel_id: "" },
      { user_id: "" },
      { user_id: "unknown" },
    ]) {
      const response = await handleSlackWebhook({
        request: client.form(new URLSearchParams({ ...form, ...invalid })),
        services,
        waitUntil: waitUntil.fn,
      });
      expect(response.status).toBe(400);
    }
    expect(waitUntil.pendingCount()).toBe(0);
    expect(slackApiOutbox.messages()).toEqual([]);

    for (const text of ["help", "link"]) {
      const accepted = await handleSlackWebhook({
        request: client.form(new URLSearchParams({ ...form, text })),
        services,
        waitUntil: waitUntil.fn,
      });
      expect(accepted.status).toBe(200);
      await waitUntil.flush();
    }
    expect(
      slackApiOutbox.calls("chat.postEphemeral").map((call) => call.params),
    ).toMatchObject([
      {
        channel: "C123",
        user: "U123",
        text: "Usage: `/team link <provider>` or `/team unlink <provider>`",
      },
      { channel: "C123", user: "U123", text: "Usage: `/team link <provider>`" },
    ]);
    expect(queue.sentRecords()).toEqual([]);
    await state.disconnect();
  });

  it("rejects invalid Slack signatures before durable state is required", async () => {
    const client = createSlackWebhookTestClient({
      signingSecret: SIGNING_SECRET,
    });
    const queue = createConversationWorkQueueTestAdapter();
    const waitUntil = client.waitUntil();
    const adapter = createJuniorSlackAdapter({
      botToken: "xoxb-test-token",
      botUserId: "U0BOT",
      signingSecret: SIGNING_SECRET,
    });

    const response = await handleSlackWebhook({
      request: client.invalidSignature({ type: "event_callback" }),
      waitUntil: waitUntil.fn,
      services: {
        getSlackAdapter: () => adapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
      },
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Invalid signature");
    expect(queue.sentRecords()).toEqual([]);
    expect(waitUntil.pendingCount()).toBe(0);
  });
});
