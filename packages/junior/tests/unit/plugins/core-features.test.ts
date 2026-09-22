import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { createCoreFeatures } from "@/chat/app/core-features";
import {
  getRegistrations,
  setPlugins,
  validatePlugins,
} from "@/chat/plugins/agent-hooks";
import { getCoreFeatures, setCoreFeatures } from "@/chat/plugins/core-features";
import { createPluginCatalogRuntime } from "@/chat/plugins/registry";
import {
  defineJuniorPlugins,
  pluginCatalogConfigFromPluginSet,
} from "@/plugins";

afterEach(() => {
  setCoreFeatures([]);
  setPlugins([]);
});

describe("core features", () => {
  it("serves core features before plugins in one registration list", () => {
    setCoreFeatures(createCoreFeatures({ briefs: { enabled: true } }));
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "acme",
          displayName: "Acme",
          description: "Test plugin",
        },
        hooks: {},
      }),
    ]);

    expect(getRegistrations().map((entry) => entry.manifest.name)).toEqual([
      "briefs",
      "memory",
      "acme",
    ]);
    expect(getCoreFeatures()[0]?.tasks).toHaveProperty("updateBrief");
  });

  it("keeps a disabled core feature limited to its event definitions", () => {
    const [briefs] = createCoreFeatures();

    expect(briefs?.conversationEvents?.map((event) => event.eventName)).toEqual(
      ["brief_updated"],
    );
    expect(briefs?.tasks).toBeUndefined();
    expect(briefs?.hooks).toBeUndefined();
  });

  it("rejects registrations that are not reserved core feature names", () => {
    const acme = defineJuniorPlugin({
      manifest: {
        name: "acme",
        displayName: "Acme",
        description: "Test plugin",
      },
    });

    expect(() => setCoreFeatures([acme])).toThrow(
      'Core feature name "acme" is not reserved for core',
    );
    const [briefs] = createCoreFeatures();
    expect(() => setCoreFeatures([briefs!, briefs!])).toThrow(
      'Duplicate core feature "briefs"',
    );
  });

  it("rejects plugins that claim a core feature name", () => {
    const plugin = defineJuniorPlugin({
      manifest: {
        name: "briefs",
        displayName: "Briefs",
        description: "Impostor",
      },
      hooks: {},
    });

    expect(() => validatePlugins([plugin])).toThrow(
      'Plugin name "briefs" is reserved for a Junior core feature',
    );

    // Manifest-only plugins skip runtime validation and enter the catalog.
    const catalog = createPluginCatalogRuntime();
    catalog.setConfig(
      pluginCatalogConfigFromPluginSet(
        defineJuniorPlugins([
          defineJuniorPlugin({
            manifest: {
              name: "memory",
              displayName: "Other Memory",
              description: "Not core memory",
            },
          }),
        ]),
      ),
    );
    expect(() => catalog.getProviders()).toThrow(
      'Plugin name "memory" is reserved for a Junior core feature',
    );
  });
});
