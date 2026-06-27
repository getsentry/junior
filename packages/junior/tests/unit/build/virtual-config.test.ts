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
      pluginRuntimeRegistrations: ["github"],
    });

    expect(code).toContain(
      'import { plugins as juniorRuntimePluginSet } from "/repo/apps/example/plugins.ts";',
    );
    expect(code).toContain("export const pluginSet = juniorRuntimePluginSet;");
    expect(code).toContain(
      'export const plugins = {"packages":["@acme/junior-demo"]};',
    );
    expect(code).toContain(
      'export const pluginRuntimeRegistrations = ["github"];',
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

  it("imports the dashboard app factory when dashboard config is present", () => {
    const code = renderVirtualConfig({
      dashboard: {
        allowedGoogleDomains: ["sentry.io"],
      },
    });

    expect(code).toContain(
      'import { createDashboardApp as juniorCreateDashboardApp } from "@sentry/junior-dashboard";',
    );
    expect(code).toContain(
      'export const dashboard = {"allowedGoogleDomains":["sentry.io"]};',
    );
  });

  it("does not import the dashboard route factory when dashboard config is disabled", () => {
    const code = renderVirtualConfig({
      dashboard: {
        disabled: true,
      },
    });

    expect(code).not.toContain("@sentry/junior-dashboard");
    expect(code).toContain("export const createDashboardApp = undefined;");
    expect(code).toContain('export const dashboard = {"disabled":true};');
  });
});
