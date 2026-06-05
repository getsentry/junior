import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { describe, expect, it } from "vitest";
import { defineJuniorPlugins } from "@/plugins";

describe("defineJuniorPlugin", () => {
  it("rejects invalid registration names", () => {
    expect(() =>
      defineJuniorPlugin({
        manifest: {
          name: "GitHub",
          displayName: "GitHub",
          description: "Invalid plugin",
        },
        hooks: {},
      }),
    ).toThrow(
      'Junior plugin registration name "GitHub" must be a lowercase plugin identifier',
    );
  });
});

describe("defineJuniorPlugins", () => {
  it("rejects duplicate package and registration names", () => {
    expect(() => defineJuniorPlugins(["@acme/plugin", "@acme/plugin"])).toThrow(
      'Duplicate plugin package name "@acme/plugin"',
    );

    expect(() =>
      defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "dupe",
            displayName: "Dupe",
            description: "Duplicate plugin",
          },
        }),
        defineJuniorPlugin({
          manifest: {
            name: "dupe",
            displayName: "Dupe",
            description: "Duplicate plugin",
          },
        }),
      ]),
    ).toThrow('Duplicate plugin registration name "dupe"');
  });

  it("rejects top-level registration names", () => {
    expect(() =>
      defineJuniorPlugin({
        name: "legacy",
        manifest: {
          name: "legacy",
          displayName: "Legacy",
          description: "Legacy plugin",
        },
      } as Parameters<typeof defineJuniorPlugin>[0] & { name: string }),
    ).toThrow("defineJuniorPlugin() uses manifest.name for identity.");
  });
});
