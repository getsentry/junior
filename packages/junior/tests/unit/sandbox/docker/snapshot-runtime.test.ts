import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.JUNIOR_SANDBOX_PROVIDER = "docker";
});

vi.mock("@/chat/plugins/catalog-runtime", () => ({
  pluginCatalogRuntime: {
    getRuntimeDependencies: () => [
      { type: "system", package: "gh" },
      { type: "npm", package: "vercel", version: "latest" },
    ],
    getRuntimePostinstall: () => [{ cmd: "agent-browser", args: ["install"] }],
  },
}));

vi.mock("@/chat/sandbox/runtime-dependencies", () => ({
  GLOBAL_RUNTIME_DEPENDENCIES: [
    { type: "system", package: "docker" },
    { type: "system", package: "ripgrep" },
  ],
  GLOBAL_RUNTIME_POSTINSTALL: [{ cmd: "install", args: ["docker-compose"] }],
}));

import { create } from "@/chat/sandbox/snapshot/profile";

describe("Docker snapshot runtime dependencies", () => {
  it("installs only the declared base packages and no postinstall commands", () => {
    const profile = create("node22");
    expect(profile?.dependencies).toEqual([
      { type: "system", package: "ripgrep" },
      { type: "system", package: "gh" },
    ]);
    expect(profile?.postinstall).toEqual([]);
    expect(profile?.floating).toBe(false);
  });
});
