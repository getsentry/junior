import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnownBlock, SectionBlock } from "@slack/web-api";
import { createHomeViewBuilder } from "@/chat/slack/app-home";
import { setPluginCatalogConfig } from "@/chat/plugins/registry";
import type { PluginManifest } from "@/chat/plugins/types";
import type {
  UserTokenStore,
  StoredTokens,
} from "@/chat/credentials/user-token-store";
import {
  DEFAULT_TEST_EXPIRED_AT_MS,
  DEFAULT_TEST_EXPIRES_AT_MS,
} from "../../fixtures/vitest";

type HomeViewBuilderDeps = Parameters<typeof createHomeViewBuilder>[0];
type HomeViewBuilder = ReturnType<typeof createHomeViewBuilder>;
type HomeView = Awaited<ReturnType<HomeViewBuilder["buildHomeView"]>>;

function createMockTokenStore(
  tokens: Record<string, StoredTokens | undefined>,
): UserTokenStore {
  return {
    get: vi.fn(async (_userId: string, provider: string) => tokens[provider]),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
}

const validToken: StoredTokens = {
  accessToken: "xoxp-test",
  refreshToken: "xoxr-test",
  expiresAt: DEFAULT_TEST_EXPIRES_AT_MS,
};

const expiredToken: StoredTokens = {
  accessToken: "xoxp-expired",
  refreshToken: "xoxr-expired",
  expiresAt: DEFAULT_TEST_EXPIRED_AT_MS,
};

function defaultProviders(): PluginManifest[] {
  return [
    {
      name: "sentry",
      description: "Sentry provider",
      capabilities: [],
      configKeys: [],
      credentials: {
        type: "oauth-bearer",
        domains: ["sentry.io"],
        authTokenEnv: "SENTRY_AUTH_TOKEN",
      },
    },
    {
      name: "notion",
      description: "Notion provider",
      capabilities: [],
      configKeys: [],
      mcp: {
        transport: "http",
        url: "https://mcp.notion.com/mcp",
      },
    },
    {
      name: "github",
      description: "GitHub provider",
      domains: ["api.github.com", "github.com"],
      capabilities: [],
      configKeys: [],
      oauth: {
        clientIdEnv: "GITHUB_APP_CLIENT_ID",
        clientSecretEnv: "GITHUB_APP_CLIENT_SECRET",
        authorizeEndpoint: "https://github.com/login/oauth/authorize",
        tokenEndpoint: "https://github.com/login/oauth/access_token",
      },
    },
    {
      name: "example-bundle",
      description: "Bundle-only plugin",
      capabilities: [],
      configKeys: [],
    },
  ];
}

function configureProviders(providers = defaultProviders()): void {
  setPluginCatalogConfig({
    inlineManifests: providers.map((manifest) => ({ manifest })),
  });
}

function createBuilder(overrides: Partial<HomeViewBuilderDeps> = {}) {
  const deps: HomeViewBuilderDeps = {
    discoverSkills: vi.fn(async () => []),
    getMcpStoredOAuthCredentials: vi.fn(async () => undefined),
    getRuntimeMetadata: vi.fn(() => ({})),
    homeDir: vi.fn(() => "/mock/app"),
    ...overrides,
  };
  return {
    builder: createHomeViewBuilder(deps),
    deps,
  };
}

async function withTempHome(
  run: (homePath: string) => Promise<void>,
): Promise<void> {
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), "junior-home-"));
  try {
    await run(homePath);
  } finally {
    await fs.rm(homePath, { recursive: true, force: true });
  }
}

function findSection(
  blocks: KnownBlock[],
  predicate: (section: SectionBlock) => boolean,
): SectionBlock | undefined {
  return blocks.find((block) => {
    const section = block as SectionBlock;
    return section.type === "section" && predicate(section);
  }) as SectionBlock | undefined;
}

function getVersionText(view: HomeView): string | undefined {
  const versionBlock = view.blocks[view.blocks.length - 1] as {
    type: string;
    elements?: Array<{ text?: string }>;
  };
  if (versionBlock.type !== "context") {
    return undefined;
  }
  return versionBlock.elements?.[0]?.text;
}

function getAllSectionText(blocks: KnownBlock[]): string {
  return blocks
    .map((block) => block as SectionBlock)
    .filter((block) => block.type === "section")
    .map((block) => block.text?.text ?? "")
    .join("\n");
}

describe("createHomeViewBuilder", () => {
  beforeEach(() => {
    configureProviders();
  });

  afterEach(() => {
    setPluginCatalogConfig(undefined);
  });

  it("shows version metadata from runtime metadata", async () => {
    const { builder } = createBuilder({
      getRuntimeMetadata: vi.fn(() => ({ version: "abc123def456" })),
    });
    const store = createMockTokenStore({});
    const view = await builder.buildHomeView("U123", store);

    expect(getVersionText(view)).toBe("*junior version:* `abc123def456`");
  });

  it("shows unknown version metadata when runtime metadata omits a version", async () => {
    const { builder } = createBuilder();
    const store = createMockTokenStore({});
    const view = await builder.buildHomeView("U123", store);

    expect(getVersionText(view)).toBe("*junior version:* `unknown`");
  });

  it("shows connected oauth-bearer provider with Unlink button", async () => {
    const { builder } = createBuilder();
    const store = createMockTokenStore({ sentry: validToken });
    const view = await builder.buildHomeView("U123", store);

    expect(view.type).toBe("home");
    const section = findSection(
      view.blocks,
      (candidate) => candidate.text?.text.includes("sentry") ?? false,
    );
    expect(section).toBeDefined();
    if (!section) {
      throw new Error("Expected connected account section for sentry");
    }

    const accessory = section.accessory as { action_id: string; value: string };
    expect(accessory.action_id).toBe("app_home_disconnect");
    expect(accessory.value).toBe("sentry");
  });

  it("shows connected MCP provider with Unlink button", async () => {
    const { builder } = createBuilder({
      getMcpStoredOAuthCredentials: vi.fn(async () => ({
        tokens: {
          access_token: "token",
          token_type: "bearer",
        },
      })),
    });
    const store = createMockTokenStore({});
    const view = await builder.buildHomeView("U123", store);

    const section = findSection(
      view.blocks,
      (candidate) => candidate.text?.text.includes("notion") ?? false,
    );
    expect(section).toBeDefined();
    if (!section) {
      throw new Error("Expected connected account section for notion");
    }

    const accessory = section.accessory as { action_id: string; value: string };
    expect(accessory.action_id).toBe("app_home_disconnect");
    expect(accessory.value).toBe("notion");
  });

  it("shows 'No connected accounts' when user has no tokens", async () => {
    const { builder } = createBuilder();
    const store = createMockTokenStore({});
    const view = await builder.buildHomeView("U123", store);

    expect(view.type).toBe("home");
    const noAccountsSection = findSection(
      view.blocks,
      (candidate) => candidate.text?.text === "No connected accounts",
    );
    expect(noAccountsSection).toBeDefined();
  });

  it("shows providers with expired access tokens because refresh token keeps connection alive", async () => {
    const { builder } = createBuilder();
    const store = createMockTokenStore({ sentry: expiredToken });
    const view = await builder.buildHomeView("U123", store);

    const section = findSection(
      view.blocks,
      (candidate) => candidate.text?.text.includes("sentry") ?? false,
    );
    expect(section?.text?.text).toContain("sentry");
  });

  it("shows GitHub providers with user OAuth tokens", async () => {
    const { builder, deps } = createBuilder();
    const store = createMockTokenStore({
      github: {
        ...validToken,
        account: {
          id: "12345",
          label: "requester",
          url: "https://github.com/requester",
        },
      },
    });
    const view = await builder.buildHomeView("U123", store);

    const section = findSection(
      view.blocks,
      (candidate) => candidate.text?.text.includes("github") ?? false,
    );
    expect(section).toBeDefined();
    expect(section?.text?.text).toContain(
      "Connected as <https://github.com/requester|requester>",
    );
    expect(store.get).toHaveBeenCalledWith("U123", "github");
    expect(store.get).not.toHaveBeenCalledWith("U123", "example-bundle");
    expect(deps.getMcpStoredOAuthCredentials).not.toHaveBeenCalledWith(
      "U123",
      "github",
    );
    expect(deps.getMcpStoredOAuthCredentials).not.toHaveBeenCalledWith(
      "U123",
      "example-bundle",
    );
  });

  it("loads DESCRIPTION.md from app root for home intro text", async () => {
    await withTempHome(async (homePath) => {
      await fs.writeFile(
        path.join(homePath, "DESCRIPTION.md"),
        "Custom app home intro",
        "utf8",
      );
      const { builder } = createBuilder({
        homeDir: vi.fn(() => homePath),
      });
      const store = createMockTokenStore({});
      const view = await builder.buildHomeView("U123", store);

      expect(getAllSectionText(view.blocks)).toContain("Custom app home intro");
    });
  });

  it("falls back to default intro text when DESCRIPTION.md is missing", async () => {
    await withTempHome(async (homePath) => {
      const { builder } = createBuilder({
        homeDir: vi.fn(() => homePath),
      });
      const store = createMockTokenStore({});
      const view = await builder.buildHomeView("U123", store);

      expect(getAllSectionText(view.blocks)).toContain(
        "I help your team investigate, summarize, and act on work in Slack.",
      );
    });
  });

  it("shows available skills as read-only list", async () => {
    const { builder } = createBuilder({
      discoverSkills: vi.fn(async () => [
        {
          name: "incident-summary",
          description: "Summarize incidents",
          skillPath: "/skills/incident-summary",
        },
        {
          name: "release-check",
          description: "Check release health",
          skillPath: "/skills/release-check",
        },
        {
          name: "jr-rpc",
          description: "Internal credential ops",
          skillPath: "/skills/jr-rpc",
        },
      ]),
    });
    const store = createMockTokenStore({});
    const view = await builder.buildHomeView("U123", store);

    const content = getAllSectionText(view.blocks);
    expect(content).toContain("*incident-summary*");
    expect(content).toContain("*release-check*");
    expect(content).not.toContain("jr-rpc");
  });
});
