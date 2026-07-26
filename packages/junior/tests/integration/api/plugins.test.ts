import { afterEach, describe, expect, test } from "vitest";
import { createJuniorApi } from "@/api";
import { pluginsSchema } from "@/api/schema";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";

describe("plugins API route", () => {
  afterEach(() => {
    pluginCatalogRuntime.setConfig(undefined);
  });

  test("projects safe metadata from configured plugin manifests", async () => {
    pluginCatalogRuntime.setConfig({
      inlineManifests: [
        {
          manifest: {
            capabilities: ["issues", "pull-requests"],
            configKeys: ["github.organization"],
            description: "GitHub development workflows.",
            displayName: "GitHub",
            name: "github",
          },
        },
      ],
    });

    const response = await createJuniorApi().request(
      "http://localhost/api/plugins",
    );

    expect(response.status).toBe(200);
    expect(pluginsSchema.parse(await response.json())).toEqual([
      {
        capabilities: ["github.issues", "github.pull-requests"],
        configKeys: ["github.organization"],
        description: "GitHub development workflows.",
        displayName: "GitHub",
        name: "github",
      },
    ]);
  });
});
