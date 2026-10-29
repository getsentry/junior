import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import webPush from "web-push";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWebSource } from "@sentry/junior-plugin-api";
import {
  createJuniorApi,
  resolveViewerUser,
  type JuniorApiVariables,
} from "@/api";
import { notificationSettingsSchema } from "@/api/schema";
import { webActorFromEmail } from "@/chat/conversations/web-input";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { closeDb, getConversationStore } from "@/chat/db";
import type { PiMessage } from "@/chat/pi/messages";
import {
  processPluginTask,
  scheduleSessionCompletedPluginTasks,
} from "@/chat/plugins/task-runner";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { upsertTurnRecord } from "@/chat/task-execution/turn-cursor";
import { mswServer } from "../../msw/server";

const EMAIL = "alice@example.com";
const PUSH_ORIGIN = "https://push.example.test";
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
  return async (method: string, path: string, body?: unknown) => {
    const response = await app.request(`http://localhost${path}`, {
      method,
      ...(body === undefined
        ? undefined
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
    });
    expect(response.status).toBe(200);
    return notificationSettingsSchema.parse(await response.json());
  };
}

/** Store one completed dashboard Turn and run the tasks it schedules. */
async function completeDashboardTurn(reply: string): Promise<string[]> {
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
  await upsertTurnRecord({
    actor: webActorFromEmail(EMAIL, { fullName: "Alice Example" }),
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
    process.env.JUNIOR_WEB_PUSH_PUBLIC_KEY = keys.publicKey;
    process.env.JUNIOR_WEB_PUSH_PRIVATE_KEY = keys.privateKey;
    process.env.JUNIOR_WEB_PUSH_SUBJECT = "mailto:junior@example.com";
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
    expect(before.deviceCount).toBe(2);
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
    expect(after.deviceCount).toBe(1);
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
});
