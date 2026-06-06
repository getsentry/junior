import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnownBlock, SectionBlock } from "@slack/web-api";
import { buildHomeView } from "@/chat/slack/app-home";
import { putMcpStoredOAuthCredentials } from "@/chat/mcp/auth-store";
import { setPluginCatalogConfig } from "@/chat/plugins/registry";
import type { PluginManifest } from "@/chat/plugins/types";
import type {
  UserTokenStore,
  StoredTokens,
} from "@/chat/credentials/user-token-store";
import {
  DEFAULT_TEST_EXPIRED_AT_MS,
  DEFAULT_TEST_EXPIRES_AT_MS,
  stubTestEnv,
  useMemoryStateAdapter,
} from "../../fixtures/vitest";

type HomeView = Awaited<ReturnType<typeof buildHomeView>>;

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

async function withTempHome(
  run: (homePath: string) => Promise<void>,
): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "junior-home-"));
  const previousCwd = process.cwd();
  const homePath = path.join(tempRoot, "app");
  try {
    await fs.mkdir(homePath, { recursive: true });
    await fs.writeFile(path.join(homePath, "SOUL.md"), "Test soul", "utf8");
    process.chdir(tempRoot);
    await run(homePath);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function writeSkill(
  homePath: string,
  name: string,
  description: string,
): Promise<void> {
  const skillDir = path.join(homePath, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "---",
      "",
      `# ${name}`,
    ].join("\n"),
    "utf8",
  );
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

describe("buildHomeView", () => {
  useMemoryStateAdapter();

  beforeEach(() => {
    configureProviders();
  });

  afterEach(() => {
    setPluginCatalogConfig(undefined);
    vi.unstubAllEnvs();
  });

  it("shows version metadata from runtime metadata", async () => {
    stubTestEnv({ VERCEL_GIT_COMMIT_SHA: "abc123def456" });
    const store = createMockTokenStore({});
    const view = await buildHomeView("U123", store);

    expect(getVersionText(view)).toBe("*junior version:* `abc123def456`");
  });

  it("shows unknown version metadata when runtime metadata omits a version", async () => {
    stubTestEnv({ VERCEL_GIT_COMMIT_SHA: undefined });
    const store = createMockTokenStore({});
    const view = await buildHomeView("U123", store);

    expect(getVersionText(view)).toBe("*junior version:* `unknown`");
  });

  it("shows connected oauth-bearer provider with Unlink button", async () => {
    const store = createMockTokenStore({ sentry: validToken });
    const view = await buildHomeView("U123", store);

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
    await putMcpStoredOAuthCredentials("U123", "notion", {
      tokens: {
        access_token: "token",
        token_type: "bearer",
      },
    });
    const store = createMockTokenStore({});
    const view = await buildHomeView("U123", store);

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
    const store = createMockTokenStore({});
    const view = await buildHomeView("U123", store);

    expect(view.type).toBe("home");
    const noAccountsSection = findSection(
      view.blocks,
      (candidate) => candidate.text?.text === "No connected accounts",
    );
    expect(noAccountsSection).toBeDefined();
  });

  it("shows providers with expired access tokens because refresh token keeps connection alive", async () => {
    const store = createMockTokenStore({ sentry: expiredToken });
    const view = await buildHomeView("U123", store);

    const section = findSection(
      view.blocks,
      (candidate) => candidate.text?.text.includes("sentry") ?? false,
    );
    expect(section?.text?.text).toContain("sentry");
  });

  it("shows GitHub providers with user OAuth tokens", async () => {
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
    const view = await buildHomeView("U123", store);

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
  });

  it("loads DESCRIPTION.md from app root for home intro text", async () => {
    await withTempHome(async (homePath) => {
      await fs.writeFile(
        path.join(homePath, "DESCRIPTION.md"),
        "Custom app home intro",
        "utf8",
      );
      const store = createMockTokenStore({});
      const view = await buildHomeView("U123", store);

      expect(getAllSectionText(view.blocks)).toContain("Custom app home intro");
    });
  });

  it("falls back to default intro text when DESCRIPTION.md is missing", async () => {
    await withTempHome(async () => {
      const store = createMockTokenStore({});
      const view = await buildHomeView("U123", store);

      expect(getAllSectionText(view.blocks)).toContain(
        "I help your team investigate, summarize, and act on work in Slack.",
      );
    });
  });

  it("shows available skills as read-only list", async () => {
    await withTempHome(async (homePath) => {
      await writeSkill(homePath, "incident-summary", "Summarize incidents");
      await writeSkill(homePath, "release-check", "Check release health");
      await writeSkill(homePath, "jr-rpc", "Internal credential ops");
      const store = createMockTokenStore({});
      const view = await buildHomeView("U123", store);

      const content = getAllSectionText(view.blocks);
      expect(content).toContain("*incident-summary*");
      expect(content).toContain("*release-check*");
      expect(content).not.toContain("jr-rpc");
    });
  });
});
