import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import {
  createdPersonalTokenSchema,
  personalTokenListSchema,
  revokePersonalTokenResponseSchema,
} from "@/api/schema";
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

async function createToken(app: ReturnType<typeof authenticatedApi>) {
  const response = await app.request("http://localhost/api/personal-tokens", {
    body: JSON.stringify({ name: "Revoke me" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return createdPersonalTokenSchema.parse(await response.json());
}

describe("personal token revoke API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("revokes an owned token and removes it from the active list", async () => {
    const app = authenticatedApi();
    const token = await createToken(app);

    const response = await app.request(
      `http://localhost/api/personal-tokens/${token.id}`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    expect(
      revokePersonalTokenResponseSchema.parse(await response.json()),
    ).toEqual({ revoked: true });
    const listResponse = await app.request(
      "http://localhost/api/personal-tokens",
    );
    expect(personalTokenListSchema.parse(await listResponse.json())).toEqual({
      tokens: [],
    });
  });

  it("does not revoke a token owned by another viewer", async () => {
    const token = await createToken(authenticatedApi());
    const response = await authenticatedApi("other@example.com").request(
      `http://localhost/api/personal-tokens/${token.id}`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(404);
  });
});
