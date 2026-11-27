import { afterEach, expect, it, vi } from "vitest";

const { runSnapshotCreate } = vi.hoisted(() => ({
  runSnapshotCreate: vi.fn(async () => {}),
}));
vi.mock("@/cli/snapshot-create", () => ({ runSnapshotCreate }));

import { getAppContext } from "@/app/context";
import { useAppContext } from "@junior-tests/fixtures/app-context";
import { create as createProfile } from "@/chat/sandbox/snapshot/profile";
import {
  defineJuniorPlugins,
  pluginCatalogConfigFromPluginSet,
} from "@/plugins";
import { evalRuntimePlugins } from "../../src/eval-plugin-fixtures";
import { warmSandboxSnapshot } from "../../src/snapshot-warmup";

afterEach(() => {
  runSnapshotCreate.mockReset();
});

it("warms the same Sentry dependency profile the scenario uses and restores the catalog", async () => {
  const packages = ["@sentry/junior-sentry"];
  useAppContext({
    pluginConfig: pluginCatalogConfigFromPluginSet(
      defineJuniorPlugins([...packages, ...evalRuntimePlugins(packages)]),
    ),
  });
  const scenarioProfile = createProfile("node22");
  expect(scenarioProfile?.dependencies).toContainEqual({
    type: "npm",
    package: "sentry",
    version: "latest",
  });
  useAppContext({ pluginConfig: { packages: [] } });
  const originalProfile = createProfile("node22");
  runSnapshotCreate.mockImplementationOnce(async () => {
    expect(createProfile("node22")).toEqual(scenarioProfile);
    expect(
      getAppContext().catalog.getDefinition("sentry")?.manifest.credentials,
    ).toMatchObject({ type: "oauth-bearer" });
  });

  await warmSandboxSnapshot(packages);
  expect(runSnapshotCreate).toHaveBeenCalledOnce();
  expect(createProfile("node22")).toEqual(originalProfile);
});
