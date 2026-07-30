import { describe, expect, it } from "vitest";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { defineJuniorPlugins } from "@/app";
import { pluginRuntimeRegistrationsFromPluginSet } from "@/plugins";

describe("plugin user pages", () => {
  it("rejects invalid page definitions", () => {
    const read = () => ({ type: "list" as const, records: [] });

    expect(() =>
      defineJuniorPlugin({
        manifest: {
          name: "memory",
          displayName: "Memory",
          description: "Memory plugin",
        },
        userPages: [
          {
            id: "Memories",
            label: "Memories",
            description: "Personal memories.",
            read,
          },
        ],
      }),
    ).toThrow(
      'Junior plugin "memory" user page id "Memories" must be a lowercase identifier.',
    );

    expect(() =>
      defineJuniorPlugin({
        manifest: {
          name: "memory",
          displayName: "Memory",
          description: "Memory plugin",
        },
        userPages: [
          {
            id: "memories",
            label: "Memories",
            description: "Personal memories.",
            read,
          },
          {
            id: "memories",
            label: "Other memories",
            description: "More personal memories.",
            read,
          },
        ],
      }),
    ).toThrow('Junior plugin "memory" has duplicate user page id "memories".');

    expect(() =>
      defineJuniorPlugin({
        manifest: {
          name: "memory",
          displayName: "Memory",
          description: "Memory plugin",
        },
        userPages: [
          {
            id: "memories",
            label: "Memories",
            description: "Personal memories.",
            navigation: "sidebar" as "primary",
            read,
          },
        ],
      }),
    ).toThrow(
      'Junior plugin "memory" user page "memories" navigation must be "primary" or "profile".',
    );
  });

  it("keeps page-only plugins in the runtime plugin set", () => {
    const plugin = defineJuniorPlugin({
      manifest: {
        name: "memory",
        displayName: "Memory",
        description: "Memory plugin",
      },
      userPages: [
        {
          id: "memories",
          label: "Memories",
          description: "Personal memories.",
          read: () => ({ type: "list", records: [] }),
        },
      ],
    });

    expect(
      pluginRuntimeRegistrationsFromPluginSet(defineJuniorPlugins([plugin])),
    ).toEqual([plugin]);
  });
});
