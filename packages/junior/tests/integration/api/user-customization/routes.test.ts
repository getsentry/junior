import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { userCustomizationSchema } from "@/api/schema";
import { closeDb } from "@/chat/db";
import { setExperimentalFeatures } from "@/chat/experimental";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { SUITE_EXPERIMENTAL } from "../../../fixtures/experimental-setup";

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

async function putCustomization(
  app: ReturnType<typeof authenticatedApi>,
  customization: string,
) {
  return await app.request("http://localhost/api/user-customization", {
    body: JSON.stringify({ customization }),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
}

describe("user customization API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("is hidden unless the app opts in", async () => {
    const response = await authenticatedApi().request(
      "http://localhost/api/user-customization",
    );

    expect(response.status).toBe(404);
  });

  it("saves, reads, and clears only the viewer's own text", async () => {
    setExperimentalFeatures({
      ...SUITE_EXPERIMENTAL,
      "user-customization": true,
    });
    const ownerApi = authenticatedApi();
    const otherApi = authenticatedApi("other@example.com");

    const saved = await putCustomization(ownerApi, "  Keep replies short.  ");
    expect(saved.status).toBe(200);
    expect(userCustomizationSchema.parse(await saved.json())).toEqual({
      customization: "Keep replies short.",
    });

    const read = await ownerApi.request(
      "http://localhost/api/user-customization",
    );
    expect(userCustomizationSchema.parse(await read.json())).toEqual({
      customization: "Keep replies short.",
    });
    const otherRead = await otherApi.request(
      "http://localhost/api/user-customization",
    );
    expect(userCustomizationSchema.parse(await otherRead.json())).toEqual({
      customization: "",
    });

    expect((await putCustomization(ownerApi, "x".repeat(1_001))).status).toBe(
      400,
    );

    await putCustomization(ownerApi, "");
    const cleared = await ownerApi.request(
      "http://localhost/api/user-customization",
    );
    expect(userCustomizationSchema.parse(await cleared.json())).toEqual({
      customization: "",
    });
  });
});
