import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { gatewayProvidersSchema } from "@/api/schema";
import { botConfig } from "@/chat/config";
import { closeDb, getDb } from "@/chat/db";
import { withEnabledGatewayProviders } from "@/chat/gateway-providers/routing";
import { resolveGatewayModel } from "@/chat/pi/client";
import type { Api, Model, StreamOptions } from "@/chat/pi/sdk";
import { resolveViewerUser, setUserAdminFromSql } from "@/chat/plugins/viewer";
import { createCache } from "@/chat/state/cache";
import { getStateAdapter } from "@/chat/state/adapter";

const BASE_URL = "https://junior.example.com";
const ADMIN = "admin@example.com";
const PERSON = "person@example.com";
const UNLISTED_MODEL = "openai/gpt-6-astra";
const SERVED: Record<string, string[]> = {
  [botConfig.modelId]: ["anthropic", "bedrock", "claudeaws", "vertex"],
  [UNLISTED_MODEL]: ["azure", "openai"],
};

async function authenticatedApi(email: string) {
  const viewer = await resolveViewerUser(email);
  if (!viewer) throw new Error(`missing viewer for ${email}`);
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (c, next) => {
    c.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

async function setEnabled(
  app: Awaited<ReturnType<typeof authenticatedApi>>,
  enabled: string[] | null,
) {
  return await app.request(`${BASE_URL}/api/gateway-providers`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

// The Messages request body that one model call sends to the gateway.
const send = withEnabledGatewayProviders(
  async (model: Model<Api>, _context: unknown, options?: StreamOptions) => {
    const payload = { model: model.id, messages: [] };
    return (await options?.onPayload?.(payload, model)) ?? payload;
  },
);
const sentBody = (modelId: string) => send(resolveGatewayModel(modelId), {});

describe("gateway providers API", () => {
  beforeEach(async () => {
    // Stands in for the gateway endpoints list of each model.
    const cache = createCache(getStateAdapter(), "gateway-served-providers");
    for (const [modelId, providers] of Object.entries(SERVED)) {
      await cache.getOrLoad(modelId, async () => ({
        value: providers,
        ttlMs: 60 * 60_000,
      }));
    }
    await resolveViewerUser(ADMIN);
    await resolveViewerUser(PERSON);
    await setUserAdminFromSql(getDb(), ADMIN, true);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await setEnabled(await authenticatedApi(ADMIN), null);
    await closeDb();
  });

  it("keeps model calls on the enabled providers that serve each model", async () => {
    const admin = await authenticatedApi(ADMIN);
    const person = await authenticatedApi(PERSON);

    // Routing changes for everyone, so only an admin can read or change it.
    expect(
      (await person.request(`${BASE_URL}/api/gateway-providers`)).status,
    ).toBe(403);
    expect((await setEnabled(person, ["anthropic"])).status).toBe(403);

    // By default every provider is enabled and no filter is sent.
    const initial = await admin.request(`${BASE_URL}/api/gateway-providers`);
    expect(gatewayProvidersSchema.parse(await initial.json())).toEqual({
      enabled: null,
      providers: ["anthropic", "bedrock", "claudeaws", "vertex"],
      models: [
        {
          id: botConfig.modelId,
          providers: ["anthropic", "bedrock", "claudeaws", "vertex"],
        },
      ],
    });
    expect(await sentBody(botConfig.modelId)).toEqual({
      model: botConfig.modelId,
      messages: [],
    });

    expect((await setEnabled(admin, ["anthropic"])).status).toBe(200);
    const saved = await admin.request(`${BASE_URL}/api/gateway-providers`);
    expect(gatewayProvidersSchema.parse(await saved.json()).enabled).toEqual([
      "anthropic",
    ]);
    expect(await sentBody(botConfig.modelId)).toEqual({
      model: botConfig.modelId,
      messages: [],
      providerOptions: { gateway: { only: ["anthropic"] } },
    });
    // No enabled provider serves this model, so it stays unfiltered.
    expect(await sentBody(UNLISTED_MODEL)).toEqual({
      model: UNLISTED_MODEL,
      messages: [],
    });
  });

  it("reuses the setting in process memory for a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const admin = await authenticatedApi(ADMIN);
    const state = getStateAdapter();
    await setEnabled(admin, ["anthropic"]);
    const only = (providers: string[]) => ({
      model: botConfig.modelId,
      messages: [],
      providerOptions: { gateway: { only: providers } },
    });
    expect(await sentBody(botConfig.modelId)).toEqual(only(["anthropic"]));

    // Another process saves a new list. This process keeps its copy, and a
    // model call makes no state read.
    await state.set("junior:gateway:enabled_providers", ["bedrock"]);
    const reads = vi.spyOn(state, "get");
    expect(await sentBody(botConfig.modelId)).toEqual(only(["anthropic"]));
    expect(reads).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 61_000);
    expect(await sentBody(botConfig.modelId)).toEqual(only(["bedrock"]));
    expect(reads).toHaveBeenCalled();

    // A save in this process applies to the next model call right away.
    await setEnabled(admin, null);
    expect(await sentBody(botConfig.modelId)).toEqual({
      model: botConfig.modelId,
      messages: [],
    });
  });
});
