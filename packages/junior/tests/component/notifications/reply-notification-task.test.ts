import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import webPush from "web-push";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebSource } from "@sentry/junior-plugin-api";
import {
  createJuniorApi,
  resolveViewerUser,
  type JuniorApiVariables,
} from "@/api";
import { notificationSettingsSchema } from "@/api/schema";
import { createSlackActor } from "@/chat/actor";
import { webActorFromUser } from "@/chat/conversations/web-input";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
  getSqlExecutor,
} from "@/chat/db";
import { resolveActorIdentityId } from "@/chat/identities/actor";
import type { PiMessage } from "@/chat/pi/messages";
import {
  processPluginTask,
  scheduleSessionCompletedPluginTasks,
} from "@/chat/plugins/task-runner";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { upsertTurnRecord } from "@/chat/task-execution/turn-cursor";
import { dndInfoOk } from "../../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiError,
  queueSlackApiResponse,
} from "../../msw/handlers/slack-api";
import { mswServer } from "../../msw/server";

const EMAIL = "alice@example.com";
const PUSH_ORIGIN = "https://fcm.googleapis.com/fcm/send";
const ENV_NAMES = [
  "JUNIOR_WEB_PUSH_PUBLIC_KEY",
  "JUNIOR_WEB_PUSH_PRIVATE_KEY",
  "JUNIOR_WEB_PUSH_SUBJECT",
] as const;

/** A browser subscription with real P-256 keys, so Web Push can encrypt. */
function browserSubscription(device: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint: `${PUSH_ORIGIN}/${device}`,
    expirationTime: null,
    keys: {
      auth: randomBytes(16).toString("base64url"),
      p256dh: ecdh.getPublicKey().toString("base64url"),
    },
  };
}

/** Call the notification API as the signed-in dashboard user. */
async function viewerApi() {
  const viewer = await resolveViewerUser(EMAIL);
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await app.request(`http://localhost${path}`, {
      method,
      ...(body === undefined
        ? undefined
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
    });
    expect(response.status).toBe(status);
    if (status !== 200) return undefined;
    return notificationSettingsSchema.parse(await response.json());
  };
}

/**
 * Store one completed dashboard Turn and run the tasks it schedules. `reply`
 * is the raw model text. `stored` is the Message that the Turn saved; a
 * no-reply Turn saves none.
 */
async function completeDashboardTurn(
  reply: string,
  stored: { text: string; quiet?: true } | null = { text: reply },
): Promise<string[]> {
  const conversationId = `local:web:${randomUUID()}`;
  const source = createWebSource(conversationId, "private");
  const destination = { platform: "local" as const, conversationId };
  await getConversationStore().recordActivity({
    conversationId,
    destination,
    nowMs: Date.now(),
    sessionSource: source,
    source: "web",
    title: "Deploy status",
    visibility: "private",
  });
  const user = await resolveViewerUser(EMAIL);
  if (!user) throw new Error("Test user was not created");
  await upsertTurnRecord({
    actor: webActorFromUser({ ...user, displayName: "Alice Example" }),
    conversationId,
    destination,
    piMessages: [
      { role: "user", content: "Is the deploy done?", timestamp: 1 },
      {
        role: "assistant",
        api: "openai-responses",
        provider: "openai",
        model: "test-model",
        usage: {},
        stopReason: "stop",
        content: [{ type: "text", text: reply }],
        timestamp: 2,
      },
    ] as PiMessage[],
    sliceId: 1,
    source,
    state: "completed",
    surface: "internal",
    turnId: "turn-1",
  });
  if (stored) {
    await getConversationEventStore().append(conversationId, [
      {
        createdAtMs: Date.now(),
        data: {
          type: "message",
          messageId: "turn-1:assistant:1",
          role: "assistant",
          text: stored.text,
          ...(stored.quiet ? { meta: { quiet: true } } : undefined),
        },
      },
    ]);
  }
  const scheduled: string[] = [];
  await scheduleSessionCompletedPluginTasks(
    { conversationId, sessionId: "turn-1" },
    {
      send: async (message) => {
        scheduled.push(`${message.plugin}.${message.name}`);
        await processPluginTask(message);
      },
    },
  );
  return scheduled;
}

describe("reply notification task", () => {
  const savedEnv = new Map<string, string | undefined>();
  let previousLinks: ReturnType<typeof setDashboardConversationLinkOptions>;
  let pushes: Request[];

  beforeEach(async () => {
    for (const name of ENV_NAMES) savedEnv.set(name, process.env[name]);
    const keys = webPush.generateVAPIDKeys();
    process.env["JUNIOR_WEB_PUSH_PUBLIC_KEY"] = keys.publicKey;
    process.env["JUNIOR_WEB_PUSH_PRIVATE_KEY"] = keys.privateKey;
    process.env["JUNIOR_WEB_PUSH_SUBJECT"] = "mailto:junior@example.com";
    previousLinks = setDashboardConversationLinkOptions({
      baseURL: "https://junior.example.com",
    });
    await getStateAdapter().connect();
    pushes = [];
    mswServer.use(
      http.post(`${PUSH_ORIGIN}/phone`, ({ request }) => {
        pushes.push(request);
        return new HttpResponse(null, { status: 201 });
      }),
      http.post(
        `${PUSH_ORIGIN}/old-laptop`,
        () => new HttpResponse(null, { status: 410 }),
      ),
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    setDashboardConversationLinkOptions(previousLinks);
    await disconnectStateAdapter();
    await closeDb();
  });

  it("pushes a dashboard reply inside working hours and removes a gone device", async () => {
    const api = await viewerApi();
    await api(
      "POST",
      "/api/notifications/subscriptions",
      browserSubscription("phone"),
    );
    const before = await api(
      "POST",
      "/api/notifications/subscriptions",
      browserSubscription("old-laptop"),
    );
    expect(before?.deviceCount).toBe(2);
    await api(
      "POST",
      "/api/notifications/subscriptions",
      {
        ...browserSubscription("phone"),
        endpoint: "https://169.254.169.254/latest/meta-data",
      },
      400,
    );
    await api("PUT", "/api/notifications/schedule", {
      workingHoursOnly: false,
      days: [],
      start: "09:00",
      end: "18:00",
    });

    await expect(
      completeDashboardTurn("The deploy finished."),
    ).resolves.toEqual(["notifications.notifyReply"]);

    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.headers.get("content-encoding")).toBe("aes128gcm");
    expect(pushes[0]!.headers.get("ttl")).toBe("43200");
    expect(pushes[0]!.headers.get("authorization")).toMatch(/^vapid /);
    const after = await api("GET", "/api/notifications");
    expect(after?.deviceCount).toBe(1);

    // A Turn with no reply, or with a Quiet message, notifies nobody.
    await completeDashboardTurn("Nothing to send.", null);
    await completeDashboardTurn("Fixed the lint failure and pushed.", {
      text: "Fixed the lint failure and pushed.",
      quiet: true,
    });
    expect(pushes).toHaveLength(1);
  });

  it("does not push outside the user's working hours", async () => {
    const api = await viewerApi();
    await api(
      "POST",
      "/api/notifications/subscriptions",
      browserSubscription("phone"),
    );
    const hour = new Date().getUTCHours();
    const clock = (offset: number) =>
      `${String((hour + offset) % 24).padStart(2, "0")}:00`;
    const settings = await api("PUT", "/api/notifications/schedule", {
      workingHoursOnly: true,
      days: [0, 1, 2, 3, 4, 5, 6],
      start: clock(2),
      end: clock(3),
      timezone: "UTC",
    });
    expect(settings).toMatchObject({
      timezone: "UTC",
      timezoneSource: "manual",
    });

    await completeDashboardTurn("Done while you were away.");

    expect(pushes).toHaveLength(0);
  });

  it("follows the linked Slack notification schedule by default and falls back to the hours", async () => {
    // Slack answers are cached per user for one minute, so each step below
    // starts in a new minute.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60_000 });
    const nextMinute = () => vi.setSystemTime(Date.now() + 60_000);
    const api = await viewerApi();
    await resolveActorIdentityId(
      getSqlExecutor(),
      createSlackActor("T123", "U0ALICE", { email: EMAIL }),
    );
    await api(
      "POST",
      "/api/notifications/subscriptions",
      browserSubscription("phone"),
    );
    const hour = new Date().getUTCHours();
    const clock = (offset: number) =>
      `${String((hour + offset) % 24).padStart(2, "0")}:00`;
    // A schedule without `followSlack` follows Slack.
    const anyTime = {
      workingHoursOnly: false,
      days: [],
      start: "09:00",
      end: "18:00",
    };
    const settings = await api("PUT", "/api/notifications/schedule", anyTime);
    expect(settings?.slackPausedNow).toBe(false);
    await completeDashboardTurn("Slack says you are around.");
    expect(pushes).toHaveLength(1);
    expect(getCapturedSlackApiCalls("dnd.info")).toEqual([
      expect.objectContaining({ params: { user: "U0ALICE" } }),
    ]);

    nextMinute();
    const nowMs = Date.now();
    queueSlackApiResponse("dnd.info", {
      body: dndInfoOk({ startMs: nowMs - 60_000, endMs: nowMs + 3_600_000 }),
    });
    await completeDashboardTurn("Slack is paused.");
    expect(pushes).toHaveLength(1);

    nextMinute();
    // Injected fault: the install has not granted `dnd:read` yet.
    queueSlackApiError("dnd.info", {
      error: "missing_scope",
      needed: "dnd:read",
    });
    await completeDashboardTurn("Slack cannot answer.");
    expect(pushes).toHaveLength(2);

    nextMinute();
    // Slack has no Do Not Disturb window, so it overrides the closed hours.
    const closedHours = {
      workingHoursOnly: true,
      days: [0, 1, 2, 3, 4, 5, 6],
      start: clock(2),
      end: clock(3),
      timezone: "UTC",
    };
    await api("PUT", "/api/notifications/schedule", closedHours);
    await completeDashboardTurn("Slack says you are around again.");
    expect(pushes).toHaveLength(3);

    nextMinute();
    await api("PUT", "/api/notifications/schedule", {
      ...closedHours,
      followSlack: false,
    });
    await completeDashboardTurn("Slack is ignored.");
    expect(pushes).toHaveLength(3);
  });
});
