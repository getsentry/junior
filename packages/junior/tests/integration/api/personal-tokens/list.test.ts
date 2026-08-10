import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import {
  createdPersonalTokenSchema,
  personalTokenListSchema,
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

async function createToken(
  app: ReturnType<typeof authenticatedApi>,
  name: string,
) {
  const response = await app.request("http://localhost/api/personal-tokens", {
    body: JSON.stringify({ name }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return createdPersonalTokenSchema.parse(await response.json());
}

describe("personal token list API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("lists only tokens owned by the authenticated viewer", async () => {
    const ownerApi = authenticatedApi();
    const token = await createToken(ownerApi, "Owner token");
    await createToken(authenticatedApi("other@example.com"), "Other token");

    const response = await ownerApi.request(
      "http://localhost/api/personal-tokens",
    );

    expect(response.status).toBe(200);
    const result = personalTokenListSchema.parse(await response.json());
    expect(result.tokens).toEqual([
      expect.objectContaining({ id: token.id, name: "Owner token" }),
    ]);
    expect(result.tokens[0]).not.toHaveProperty("token");
  });
});
