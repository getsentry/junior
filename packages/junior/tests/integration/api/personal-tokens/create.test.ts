import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { apiErrorSchema, createdPersonalTokenSchema } from "@/api/schema";
import { closeDb } from "@/chat/db";

function authenticatedApi(email = "person@example.com") {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (c, next) => {
    const viewer = await resolveViewerUser(email);
    if (!viewer) {
      throw new Error(`missing viewer for ${email}`);
    }
    c.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

describe("personal token create API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("creates a personal token and returns its secret once", async () => {
    const response = await authenticatedApi().request(
      "http://localhost/api/personal-tokens",
      {
        body: JSON.stringify({ name: "Local transcript agent" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );

    expect(response.status).toBe(200);
    const token = createdPersonalTokenSchema.parse(await response.json());
    expect(token).toMatchObject({ name: "Local transcript agent" });
    expect(token.token).toMatch(/^jr_pat_/);
    expect(token.tokenSuffix).toBe(token.token.slice(-8));
  });

  it("rejects an invalid token name", async () => {
    const response = await authenticatedApi().request(
      "http://localhost/api/personal-tokens",
      {
        body: JSON.stringify({ name: "" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );

    expect(response.status).toBe(400);
    expect(apiErrorSchema.parse(await response.json())).toEqual({
      error: "Invalid request body.",
    });
  });
});
