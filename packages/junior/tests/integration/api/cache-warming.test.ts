import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { cacheWarmingBreakerListSchema } from "@/api/schema";
import { connectedState } from "@/chat/cache-warming/request";
import { closeDb, getDb } from "@/chat/db";
import { resolveViewerUser, setUserAdminFromSql } from "@/chat/plugins/viewer";

const BASE_URL = "https://junior.example.com";
const ADMIN = "admin@example.com";
const PERSON = "person@example.com";
const OPEN_KEY = "junior:cache_warming:breaker:anthropic:open";
const OUTCOMES_KEY = "junior:cache_warming:breaker:anthropic:outcomes";

function authenticatedApi(email: string) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (c, next) => {
    const viewer = await resolveViewerUser(email);
    if (!viewer) throw new Error(`missing viewer for ${email}`);
    c.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

async function listBreakers(app: ReturnType<typeof authenticatedApi>) {
  const response = await app.request(`${BASE_URL}/api/cache-warming/breakers`);
  expect(response.status).toBe(200);
  return cacheWarmingBreakerListSchema.parse(await response.json()).breakers;
}

describe("cache warming API", () => {
  beforeEach(async () => {
    await resolveViewerUser(ADMIN);
    await resolveViewerUser(PERSON);
    await setUserAdminFromSql(getDb(), ADMIN, true);
  });

  afterEach(async () => {
    const state = await connectedState();
    await state.delete(OPEN_KEY);
    await state.delete(OUTCOMES_KEY);
    await closeDb();
  });

  it("lets an admin turn warming back on after the breaker opens", async () => {
    const state = await connectedState();
    await state.set(OPEN_KEY, true, 60_000);
    await state.appendToList(OUTCOMES_KEY, 1, { maxLength: 20 });
    const admin = authenticatedApi(ADMIN);
    const person = authenticatedApi(PERSON);

    // The breaker stops warming for everyone, so only an admin can close it.
    expect(
      (await person.request(`${BASE_URL}/api/cache-warming/breakers`)).status,
    ).toBe(403);
    expect(
      (
        await person.request(
          `${BASE_URL}/api/cache-warming/breakers/anthropic`,
          {
            method: "DELETE",
          },
        )
      ).status,
    ).toBe(403);
    expect(await state.get(OPEN_KEY)).toBe(true);

    expect(await listBreakers(admin)).toContainEqual({
      provider: "anthropic",
      open: true,
    });
    const closed = await admin.request(
      `${BASE_URL}/api/cache-warming/breakers/anthropic`,
      { method: "DELETE" },
    );
    expect(closed.status).toBe(200);
    expect(await listBreakers(admin)).toContainEqual({
      provider: "anthropic",
      open: false,
    });
    // Old misses must not reopen the breaker on the next miss.
    expect(await state.getList(OUTCOMES_KEY)).toEqual([]);

    expect(
      (
        await admin.request(
          `${BASE_URL}/api/cache-warming/breakers/constructor`,
          {
            method: "DELETE",
          },
        )
      ).status,
    ).toBe(404);
  });
});
