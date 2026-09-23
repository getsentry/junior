import { afterEach, expect, it, vi } from "vitest";

const { runSnapshotCreate } = vi.hoisted(() => ({
  runSnapshotCreate: vi.fn(async () => {}),
}));
vi.mock("@/cli/snapshot-create", () => ({ runSnapshotCreate }));

import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { create as createProfile } from "@/chat/sandbox/snapshot/profile";
import {
  defineJuniorPlugins,
  pluginCatalogConfigFromPluginSet,
} from "@/plugins";
import path from "node:path";
import {
  loadEvalPluginFixtures,
  evalRuntimePlugins,
} from "../../../src/eval-plugin-fixtures";
import { warmSandboxSnapshot } from "../../../src/snapshot-warmup";

const previousCatalog = pluginCatalogRuntime.setConfig(undefined);
afterEach(() => {
  pluginCatalogRuntime.setConfig(previousCatalog);
  runSnapshotCreate.mockReset();
});

it("warms the same Sentry dependency profile the scenario uses and restores the catalog", async () => {
  const packages = ["@sentry/junior-sentry"];
  pluginCatalogRuntime.setConfig(
    pluginCatalogConfigFromPluginSet(
      defineJuniorPlugins([...packages, ...evalRuntimePlugins(packages)]),
    ),
  );
  const scenarioProfile = createProfile("node22");
  expect(scenarioProfile?.dependencies).toContainEqual({
    type: "npm",
    package: "sentry",
    version: "latest",
  });
  pluginCatalogRuntime.setConfig({ packages: [] });
  const originalProfile = createProfile("node22");
  runSnapshotCreate.mockImplementationOnce(async () => {
    expect(createProfile("node22")).toEqual(scenarioProfile);
    expect(
      pluginCatalogRuntime.getDefinition("sentry")?.manifest.credentials,
    ).toMatchObject({ type: "oauth-bearer" });
  });

  await warmSandboxSnapshot(packages);
  expect(runSnapshotCreate).toHaveBeenCalledOnce();
  expect(createProfile("node22")).toEqual(originalProfile);
});

it("preserves local fixture skill ownership", () => {
  const root = path.resolve(import.meta.dirname, "../../../fixtures/plugins");
  const fixture = loadEvalPluginFixtures([root]);
  pluginCatalogRuntime.setConfig({
    packages: [],
    inlineManifests: fixture.inlineManifests,
  });
  expect(pluginCatalogRuntime.getOAuthConfig("eval-oauth")).toBeDefined();
  expect(
    pluginCatalogRuntime.getForSkillPath(
      path.join(root, "eval-oauth/skills/eval-oauth/SKILL.md"),
    )?.manifest.name,
  ).toBe("eval-oauth");
});
