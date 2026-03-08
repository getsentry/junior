import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnownBlock, SectionBlock } from "@slack/web-api";
import { buildHomeView, publishAppHomeView } from "@/chat/app-home";
import type { UserTokenStore, StoredTokens } from "@/chat/credentials/user-token-store";
import { discoverSkills } from "@/chat/skills";

vi.mock("@/chat/plugins/registry", () => ({
  getPluginProviders: () => [
    {
      manifest: {
        name: "sentry",
        description: "Sentry provider",
        credentials: {
          type: "oauth-bearer"
        }
      }
    },
    {
      manifest: {
        name: "github",
        description: "GitHub provider",
        credentials: {
          type: "github-app"
        }
      }
    },
    {
      manifest: {
        name: "example-bundle",
        description: "Bundle-only plugin"
      }
    }
  ]
}));

vi.mock("@/chat/home", () => ({
  homeDir: () => "/mock/app"
}));

vi.mock("@/chat/skills", () => ({
  discoverSkills: vi.fn(async () => [])
}));

function createMockTokenStore(tokens: Record<string, StoredTokens | undefined>): UserTokenStore {
  return {
    get: vi.fn(async (_userId: string, provider: string) => tokens[provider]),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {})
  };
}

const validToken: StoredTokens = {
  accessToken: "xoxp-test",
  refreshToken: "xoxr-test",
  expiresAt: Date.now() + 3600_000
};

const expiredToken: StoredTokens = {
  accessToken: "xoxp-expired",
  refreshToken: "xoxr-expired",
  expiresAt: Date.now() - 1000
};

function findSection(blocks: KnownBlock[], predicate: (section: SectionBlock) => boolean): SectionBlock | undefined {
  return blocks.find((block) => {
    const section = block as SectionBlock;
    return section.type === "section" && predicate(section);
  }) as SectionBlock | undefined;
}

function getVersionText(view: Awaited<ReturnType<typeof buildHomeView>>): string | undefined {
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
  let readFileSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    readFileSpy = vi.spyOn(fs, "readFileSync").mockReturnValue("About text");
  });

  afterEach(() => {
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    vi.restoreAllMocks();
    vi.mocked(discoverSkills).mockResolvedValue([]);
  });

  it("shows version metadata from VERCEL_GIT_COMMIT_SHA", async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "abc123def456";
    const store = createMockTokenStore({});
    const view = await buildHomeView("U123", store);

    expect(getVersionText(view)).toBe("*junior version:* `abc123def456`");
  });

  it("shows unknown version metadata when VERCEL_GIT_COMMIT_SHA is missing", async () => {
    const store = createMockTokenStore({});
    const view = await buildHomeView("U123", store);

    expect(getVersionText(view)).toBe("*junior version:* `unknown`");
  });

  it("shows connected oauth-bearer provider with Unlink button", async () => {
    const store = createMockTokenStore({ sentry: validToken });
    const view = await buildHomeView("U123", store);

    expect(view.type).toBe("home");
    const section = findSection(view.blocks, (candidate) =>
      candidate.text?.text.includes("sentry") ?? false
    );
    expect(section).toBeDefined();
    if (!section) {
      throw new Error("Expected connected account section for sentry");
    }

    const accessory = section.accessory as { action_id: string; value: string };
    expect(accessory.action_id).toBe("app_home_disconnect");
    expect(accessory.value).toBe("sentry");
  });

  it("shows 'No connected accounts' when user has no tokens", async () => {
    const store = createMockTokenStore({});
    const view = await buildHomeView("U123", store);

    expect(view.type).toBe("home");
    const noAccountsSection = findSection(view.blocks, (candidate) =>
      candidate.text?.text === "No connected accounts"
    );
    expect(noAccountsSection).toBeDefined();
  });

  it("shows providers with expired access tokens (refresh token keeps connection alive)", async () => {
    const store = createMockTokenStore({ sentry: expiredToken });
    const view = await buildHomeView("U123", store);

    const section = findSection(view.blocks, (candidate) =>
      candidate.text?.text.includes("sentry") ?? false
    );
    expect(section?.text?.text).toContain("sentry");
  });

  it("excludes github-app providers (no per-user auth)", async () => {
    // github-app tokens would never be in the user token store, but even if
    // the store returned something, buildHomeView skips non-oauth-bearer providers.
    const store = createMockTokenStore({ github: validToken });
    const view = await buildHomeView("U123", store);

    const noAccountsSection = findSection(view.blocks, (candidate) =>
      candidate.text?.text === "No connected accounts"
    );
    expect(noAccountsSection).toBeDefined();
    // github provider is github-app type, so store.get should not be called for it
    expect(store.get).not.toHaveBeenCalledWith("U123", "github");
    expect(store.get).not.toHaveBeenCalledWith("U123", "example-bundle");
  });

  it("loads ABOUT.md from app root for home intro text", async () => {
    readFileSpy.mockReturnValue("Custom app home intro");
    const store = createMockTokenStore({});
    const view = await buildHomeView("U123", store);

    expect(getAllSectionText(view.blocks)).toContain("Custom app home intro");
    expect(fs.readFileSync).toHaveBeenCalledWith("/mock/app/ABOUT.md", "utf8");
  });

  it("falls back to default intro text when ABOUT.md is missing", async () => {
    readFileSpy.mockImplementation(() => {
      throw new Error("missing");
    });
    const store = createMockTokenStore({});
    const view = await buildHomeView("U123", store);

    expect(getAllSectionText(view.blocks)).toContain(
      "I help your team investigate, summarize, and act on work in Slack."
    );
  });

  it("shows available skills as read-only list", async () => {
    vi.mocked(discoverSkills).mockResolvedValue([
      { name: "incident-summary", description: "Summarize incidents", skillPath: "/skills/incident-summary" },
      { name: "release-check", description: "Check release health", skillPath: "/skills/release-check" },
      { name: "jr-rpc", description: "Internal credential ops", skillPath: "/skills/jr-rpc" }
    ]);

    const store = createMockTokenStore({});
    const view = await buildHomeView("U123", store);

    const content = getAllSectionText(view.blocks);
    expect(content).toContain("`!incident-summary`");
    expect(content).toContain("`!release-check`");
    expect(content).not.toContain("jr-rpc");
  });
});

describe("publishAppHomeView", () => {
  it("calls views.publish with user_id and home view", async () => {
    const store = createMockTokenStore({ sentry: validToken });
    const mockClient = {
      views: {
        publish: vi.fn(async () => ({ ok: true }))
      }
    };

    await publishAppHomeView(mockClient as never, "U123", store);

    expect(mockClient.views.publish).toHaveBeenCalledOnce();
    expect(mockClient.views.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "U123",
        view: expect.objectContaining({
          type: "home",
          blocks: expect.arrayContaining([expect.anything()])
        })
      })
    );
  });
});
