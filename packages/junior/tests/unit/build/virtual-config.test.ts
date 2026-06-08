import { describe, expect, it } from "vitest";
import { renderVirtualConfig } from "@/build/virtual-config";

describe("renderVirtualConfig", () => {
  it("exports runtime plugin modules for createApp", () => {
    const code = renderVirtualConfig({
      pluginModule: {
        exportName: "plugins",
        specifier: "/repo/apps/example/plugins.ts",
      },
      plugins: {
        packages: ["@acme/junior-demo"],
      },
      pluginHookRegistrations: ["github"],
    });

    expect(code).toContain(
      'import { plugins as juniorRuntimePluginSet } from "/repo/apps/example/plugins.ts";',
    );
    expect(code).toContain("export const pluginSet = juniorRuntimePluginSet;");
    expect(code).toContain(
      'export const plugins = {"packages":["@acme/junior-demo"]};',
    );
    expect(code).toContain(
      'export const pluginHookRegistrations = ["github"];',
    );
  });

  it("supports default runtime plugin exports", () => {
    const code = renderVirtualConfig({
      pluginModule: {
        exportName: "default",
        specifier: "@acme/junior-plugins",
      },
    });

    expect(code).toContain(
      'import juniorRuntimePluginSet from "@acme/junior-plugins";',
    );
  });
});
