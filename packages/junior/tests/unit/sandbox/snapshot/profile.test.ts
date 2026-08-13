import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dependenciesMock, globalPostinstall, postinstallMock } = vi.hoisted(
  () => ({
    dependenciesMock: vi.fn(),
    globalPostinstall: [] as Array<{ cmd: string; args?: string[] }>,
    postinstallMock: vi.fn(),
  }),
);

vi.mock("@/chat/plugins/catalog-runtime", () => ({
  pluginCatalogRuntime: {
    getRuntimeDependencies: dependenciesMock,
    getRuntimePostinstall: postinstallMock,
  },
}));

vi.mock("@/chat/sandbox/runtime-dependencies", () => ({
  GLOBAL_RUNTIME_DEPENDENCIES: [],
  GLOBAL_RUNTIME_POSTINSTALL: globalPostinstall,
}));

import { create, isStale } from "@/chat/sandbox/snapshot/profile";

describe("snapshot dependency profile", () => {
  beforeEach(() => {
    dependenciesMock.mockReset();
    postinstallMock.mockReset();
    dependenciesMock.mockReturnValue([]);
    postinstallMock.mockReturnValue([]);
    globalPostinstall.length = 0;
    delete process.env.SANDBOX_SNAPSHOT_REBUILD_EPOCH;
    delete process.env.SANDBOX_SNAPSHOT_FLOATING_MAX_AGE_MS;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires floating npm selectors but keeps exact versions reusable", () => {
    dependenciesMock.mockReturnValue([
      { type: "npm", package: "floating", version: "latest" },
    ]);
    const floating = create("node22");
    expect(floating).not.toBeNull();
    expect(
      isStale(floating!, new Date("2026-03-01T00:00:00.000Z").getTime()),
    ).toBe(true);

    dependenciesMock.mockReturnValue([
      { type: "npm", package: "exact", version: "1.2.3" },
    ]);
    const exact = create("node22");
    expect(exact).not.toBeNull();
    expect(
      isStale(exact!, new Date("2025-03-01T00:00:00.000Z").getTime()),
    ).toBe(false);
  });

  it("includes pinned global postinstall without making the profile floating", () => {
    globalPostinstall.push({ cmd: "install", args: ["docker-compose"] });

    const profile = create("node22");
    expect(profile?.postinstall).toEqual([
      { cmd: "install", args: ["docker-compose"] },
    ]);
    expect(profile?.floating).toBe(false);
  });

  it("treats plugin postinstall profiles as floating", () => {
    postinstallMock.mockReturnValue([
      { cmd: "agent-browser", args: ["install"] },
    ]);
    const profile = create("node22");
    expect(profile?.floating).toBe(true);
  });

  it("includes Workspace contents in the profile hash", () => {
    const workspace = {
      id: "workspace-1",
      name: "sentry",
      setupScript: "pnpm install",
      repos: [
        {
          provider: "github",
          repo: "getsentry/sentry",
          isPrimary: true,
        },
      ],
    };

    const first = create("node22", workspace);
    const changedSetup = create("node22", {
      ...workspace,
      setupScript: "pnpm install --frozen-lockfile",
    });
    const changedRepo = create("node22", {
      ...workspace,
      repos: [{ ...workspace.repos[0]!, repo: "getsentry/junior" }],
    });

    expect(first?.hash).not.toBe(changedSetup?.hash);
    expect(first?.hash).not.toBe(changedRepo?.hash);
    expect(first?.floating).toBe(true);
  });

  it("normalizes repository order and ignores the primary selection", () => {
    const repos = [
      {
        provider: "github",
        repo: "getsentry/sentry",
        isPrimary: true,
      },
      {
        provider: "github",
        repo: "getsentry/relay",
        isPrimary: false,
      },
    ];
    const first = create("node22", {
      id: "workspace-1",
      name: "sentry",
      setupScript: "",
      repos,
    });
    const reordered = create("node22", {
      id: "workspace-1",
      name: "sentry",
      setupScript: "",
      repos: [...repos]
        .reverse()
        .map((repo) => ({ ...repo, isPrimary: !repo.isPrimary })),
    });

    expect(first?.hash).toBe(reordered?.hash);
  });

  it("keeps workspace profile hashes stable without localeCompare", () => {
    const updatedAt = new Date("2026-03-10T00:00:00.000Z");
    // Code-point order differs from some locales for mixed case / symbols.
    const reposA = [
      {
        provider: "github",
        repo: "getsentry/Zulu",
        isPrimary: true,
      },
      {
        provider: "github",
        repo: "getsentry/alpha",
        isPrimary: false,
      },
    ];
    const reposB = [...reposA].reverse();
    const first = create("node22", {
      id: "workspace-1",
      name: "sentry",
      setupScript: "pnpm install",
      updatedAt,
      repos: reposA,
    });
    const second = create("node22", {
      id: "workspace-1",
      name: "sentry",
      setupScript: "pnpm install",
      updatedAt,
      repos: reposB,
    });
    expect(first?.hash).toBe(second?.hash);
  });

  it("ignores isPrimary when hashing workspace profiles", () => {
    const updatedAt = new Date("2026-03-10T00:00:00.000Z");
    const first = create("node22", {
      id: "workspace-1",
      name: "sentry",
      setupScript: "pnpm install",
      updatedAt,
      repos: [
        {
          provider: "github",
          repo: "getsentry/sentry",
          checkoutPath: "sentry",
          isPrimary: true,
        },
        {
          provider: "github",
          repo: "getsentry/relay",
          checkoutPath: "relay",
          isPrimary: false,
        },
      ],
    });
    const second = create("node22", {
      id: "workspace-1",
      name: "sentry",
      setupScript: "pnpm install",
      updatedAt,
      repos: [
        {
          provider: "github",
          repo: "getsentry/sentry",
          checkoutPath: "sentry",
          isPrimary: false,
        },
        {
          provider: "github",
          repo: "getsentry/relay",
          checkoutPath: "relay",
          isPrimary: true,
        },
      ],
    });

    expect(first?.hash).toBe(second?.hash);
  });

  it("installs dependencies in the complete Workspace profile", () => {
    dependenciesMock.mockReturnValue([
      { type: "npm", package: "example", version: "1.2.3" },
    ]);
    const workspace = {
      id: "workspace-1",
      name: "sentry",
      setupScript: "",
      repos: [],
    };
    const first = create("node22", workspace);

    dependenciesMock.mockReturnValue([
      { type: "npm", package: "example", version: "2.0.0" },
    ]);
    const changed = create("node22", workspace);

    expect(first?.dependencies).toEqual([
      { type: "npm", package: "example", version: "1.2.3" },
    ]);
    expect(first?.hash).not.toBe(changed?.hash);
  });

  it("changes the hash when the rebuild epoch changes", () => {
    dependenciesMock.mockReturnValue([
      { type: "npm", package: "example", version: "1.2.3" },
    ]);
    process.env.SANDBOX_SNAPSHOT_REBUILD_EPOCH = "epoch-a";
    const first = create("node22");
    process.env.SANDBOX_SNAPSHOT_REBUILD_EPOCH = "epoch-b";
    const second = create("node22");

    expect(first?.hash).not.toBe(second?.hash);
  });

  it("rejects conflicting npm versions", () => {
    dependenciesMock.mockReturnValue([
      { type: "npm", package: "example", version: "1.2.3" },
      { type: "npm", package: "example", version: "2.0.0" },
    ]);

    expect(() => create("node22")).toThrow(
      "Conflicting runtime dependency versions for example: 1.2.3 and 2.0.0",
    );
  });

  it("deduplicates identical dependencies", () => {
    dependenciesMock.mockReturnValue([
      { type: "npm", package: "example", version: "1.2.3" },
      { type: "npm", package: "example", version: "1.2.3" },
    ]);

    expect(create("node22")?.dependencies).toEqual([
      { type: "npm", package: "example", version: "1.2.3" },
    ]);
  });
});
