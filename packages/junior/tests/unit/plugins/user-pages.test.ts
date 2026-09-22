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
          name: "notes",
          displayName: "Notes",
          description: "Notes plugin",
        },
        userPages: [
          {
            id: "Notes",
            label: "Notes",
            description: "Personal notes.",
            read,
          },
        ],
      }),
    ).toThrow(
      'Junior plugin "notes" user page id "Notes" must be a lowercase identifier.',
    );

    expect(() =>
      defineJuniorPlugin({
        manifest: {
          name: "notes",
          displayName: "Notes",
          description: "Notes plugin",
        },
        userPages: [
          {
            id: "notes",
            label: "Notes",
            description: "Personal notes.",
            read,
          },
          {
            id: "notes",
            label: "Other memories",
            description: "More personal memories.",
            read,
          },
        ],
      }),
    ).toThrow('Junior plugin "notes" has duplicate user page id "notes".');

    expect(() =>
      defineJuniorPlugin({
        manifest: {
          name: "notes",
          displayName: "Notes",
          description: "Notes plugin",
        },
        userPages: [
          {
            id: "notes",
            label: "Notes",
            description: "Personal notes.",
            navigation: "sidebar" as "primary",
            read,
          },
        ],
      }),
    ).toThrow(
      'Junior plugin "notes" user page "notes" navigation must be "primary" or "profile".',
    );
  });

  it("keeps page-only plugins in the runtime plugin set", () => {
    const plugin = defineJuniorPlugin({
      manifest: {
        name: "notes",
        displayName: "Notes",
        description: "Notes plugin",
      },
      userPages: [
        {
          id: "notes",
          label: "Notes",
          description: "Personal notes.",
          read: () => ({ type: "list", records: [] }),
        },
      ],
    });

    expect(
      pluginRuntimeRegistrationsFromPluginSet(defineJuniorPlugins([plugin])),
    ).toEqual([plugin]);
  });
});
