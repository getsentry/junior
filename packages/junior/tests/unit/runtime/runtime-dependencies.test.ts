import { beforeEach, describe, expect, it, vi } from "vitest";

const { getRuntimeDependenciesMock } = vi.hoisted(() => ({
  getRuntimeDependenciesMock: vi.fn(),
}));

vi.mock("@/chat/plugins/catalog-runtime", () => ({
  pluginCatalogRuntime: {
    getRuntimeDependencies: getRuntimeDependenciesMock,
  },
}));

import { getSandboxRuntimeDependencies } from "@/chat/sandbox/runtime-dependencies";

describe("sandbox runtime dependencies", () => {
  beforeEach(() => {
    getRuntimeDependenciesMock.mockReset();
  });

  it("includes Docker in the default sandbox baseline", () => {
    getRuntimeDependenciesMock.mockReturnValue([]);

    expect(getSandboxRuntimeDependencies()).toEqual([
      { type: "system", package: "docker" },
    ]);
  });

  it("merges plugin dependencies without duplicating baseline packages", () => {
    getRuntimeDependenciesMock.mockReturnValue([
      { type: "system", package: "gh" },
      { type: "system", package: "docker" },
      { type: "npm", package: "example-cli", version: "1.0.0" },
    ]);

    expect(getSandboxRuntimeDependencies()).toEqual([
      { type: "npm", package: "example-cli", version: "1.0.0" },
      { type: "system", package: "docker" },
      { type: "system", package: "gh" },
    ]);
  });
});
