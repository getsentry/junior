import { describe, expect, test } from "vitest";
import { createJuniorApi } from "@/api";
import { pluginsSchema } from "@/api/schema";
import { useAppContext } from "../../fixtures/app-context";

describe("plugins API route", () => {
  test("projects safe metadata from configured plugin manifests", async () => {
    useAppContext({
      pluginConfig: {
        inlineManifests: [
          {
            manifest: {
              configKeys: ["github.organization"],
              description: "GitHub development workflows.",
              displayName: "GitHub",
              name: "github",
            },
          },
        ],
      },
    });

    const response = await createJuniorApi().request(
      "http://localhost/api/plugins",
    );

    expect(response.status).toBe(200);
    expect(pluginsSchema.parse(await response.json())).toEqual([
      {
        configKeys: ["github.organization"],
        description: "GitHub development workflows.",
        displayName: "GitHub",
        name: "github",
      },
    ]);
  });
});
