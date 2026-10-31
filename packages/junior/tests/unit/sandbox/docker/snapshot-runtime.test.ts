import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.JUNIOR_SANDBOX_PROVIDER = "docker";
});

vi.mock("@/chat/plugins/catalog-runtime", () => ({
  pluginCatalogRuntime: {
    getRuntimeDependencies: () => [
      { type: "system", package: "gh" },
      { type: "system", package: "jq" },
      { type: "npm", package: "vercel", version: "latest" },
    ],
    getRuntimePostinstall: () => [{ cmd: "agent-browser", args: ["install"] }],
  },
}));

vi.mock("@/chat/sandbox/runtime-dependencies", () => ({
  GLOBAL_RUNTIME_DEPENDENCIES: [{ type: "system", package: "ripgrep" }],
  GLOBAL_RUNTIME_POSTINSTALL: [{ cmd: "install", args: ["docker-compose"] }],
}));

import { create } from "@/chat/sandbox/snapshot/profile";

describe("Docker snapshot runtime dependencies", () => {
  afterEach(() => {
    delete process.env.JUNIOR_DOCKER_SANDBOX_RUNTIME_DEPENDENCIES;
  });

  it("installs only the named dependencies and no postinstall commands", () => {
    const full = create("node22");
    expect(full?.dependencyCount).toBe(4);
    expect(full?.postinstall).toHaveLength(2);

    process.env.JUNIOR_DOCKER_SANDBOX_RUNTIME_DEPENDENCIES = " gh, ripgrep ,";
    const tiny = create("node22");
    expect(tiny?.dependencies).toEqual([
      { type: "system", package: "ripgrep" },
      { type: "system", package: "gh" },
    ]);
    expect(tiny?.postinstall).toEqual([]);
    expect(tiny?.floating).toBe(false);
    expect(tiny?.hash).not.toBe(full?.hash);
  });

  it("rejects names that are not declared dependencies", () => {
    process.env.JUNIOR_DOCKER_SANDBOX_RUNTIME_DEPENDENCIES = "gh,ripgrp";
    expect(() => create("node22")).toThrow(/ripgrp/);
  });
});
