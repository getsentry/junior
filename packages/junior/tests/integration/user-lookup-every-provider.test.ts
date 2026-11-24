import { describe, expect, it, vi } from "vitest";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { createApp, defineJuniorPlugins } from "@/app";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import { unlinkProvider } from "@/chat/credentials/unlink-provider";
import { findLinkedHandle } from "@/chat/identities/user-lookup";
import { readIdentityById } from "@/chat/plugins/viewer";
import { parseSlackTeamId } from "@/chat/slack/ids";
import { usersInfoOk, usersListPage } from "../fixtures/slack/factories/api";
import { measureSql } from "../fixtures/sql-budget";
import {
  executeTool,
  lookupTool,
  seedLinkedIdentities,
} from "../fixtures/user-lookup";
import {
  getCapturedSlackApiCalls,
  queueSlackApiError,
  queueSlackApiResponse,
} from "../msw/handlers/slack-api";

describe("userLookup without a provider", () => {
  it("merges the providers that matched one person", async () => {
    await seedLinkedIdentities({
      githubId: "12345",
      githubHandle: "dcramer",
      slackUserId: "U039RR91S",
      slackHandle: "dcramer",
    });
    queueSlackApiResponse("users.list", {
      body: usersListPage({
        members: [{ id: "U039RR91S", name: "dcramer", realName: "David" }],
      }),
    });

    const result = await executeTool(lookupTool(), { query: "dcramer" });

    expect(result).not.toHaveProperty("provider");
    expect(result).toMatchObject({
      count: 1,
      ambiguous: false,
      mention: "<@U039RR91S>",
      user: {
        provider: "slack",
        has_user: true,
        matched_providers: ["slack", "github"],
        linked_identities: [{ provider: "github", handle: "dcramer" }],
      },
    });
  });

  it("keeps an exact match when Slack name hits fill the cap", async () => {
    await seedLinkedIdentities({
      githubId: "12345",
      githubHandle: "dcramer",
      slackUserId: "U039RR91S",
      slackHandle: "david",
    });
    queueSlackApiResponse("users.list", {
      body: usersListPage({
        members: Array.from({ length: 10 }, (_, index) => ({
          id: `UNAME${index}`,
          name: `dcramer${index}`,
        })),
      }),
    });

    const result = await executeTool(lookupTool(), { query: "dcramer" });

    expect(result).toMatchObject({ count: 10, ambiguous: true });
    expect(result.users[0]).toMatchObject({
      id: "U039RR91S",
      has_user: true,
      matched_providers: ["github"],
    });
    // A Slack name hit that Junior has no User for.
    expect(result.users[1]).toMatchObject({
      provider: "slack",
      has_user: false,
      matched_providers: ["slack"],
    });
  });

  it("finds a person by a Slack mention", async () => {
    queueSlackApiResponse("users.info", {
      body: usersInfoOk({ userId: "U039RR91S", userName: "david" }),
    });

    await expect(
      executeTool(lookupTool(), { query: "<@U039RR91S|david>" }),
    ).resolves.toMatchObject({
      count: 1,
      user: { id: "U039RR91S", matched_providers: ["slack"] },
    });
  });

  it("flags several candidates as ambiguous", async () => {
    await seedLinkedIdentities({
      githubId: "1",
      githubHandle: "shared-login",
      slackUserId: "U1",
      slackHandle: "alice",
    });
    await seedLinkedIdentities({
      githubId: "2",
      githubHandle: "shared-login",
      slackUserId: "U2",
      slackHandle: "bob",
    });
    queueSlackApiResponse("users.list", { body: usersListPage() });

    const result = await executeTool(lookupTool(), {
      query: "shared-login",
    });

    expect(result).toMatchObject({ count: 2, ambiguous: true });
    expect(result.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "U1", matched_providers: ["github"] }),
        expect.objectContaining({ id: "U2", matched_providers: ["github"] }),
      ]),
    );
  });

  it("links accounts that a plugin search finds", async () => {
    await seedLinkedIdentities({
      githubId: "12345",
      githubHandle: "dcramer",
      slackUserId: "U039RR91S",
      slackHandle: "david",
    });
    queueSlackApiResponse("users.list", { body: usersListPage() });
    await createApp({
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "github",
            displayName: "GitHub",
            description: "Searches test accounts",
          },
          hooks: {
            searchUsers: ({ query }) =>
              query === "dcramer"
                ? [
                    { id: "12345", handle: "dcramer" },
                    {
                      id: "67890",
                      handle: "dcramer-alt",
                      displayName: "Alt",
                    },
                  ]
                : [],
          },
        }),
      ]),
    });

    const result = await executeTool(lookupTool(), { query: "dcramer" });

    expect(result).toMatchObject({
      count: 1,
      ambiguous: true,
      user: { id: "U039RR91S", matched_providers: ["github"] },
      accounts: [
        {
          provider: "github",
          has_user: false,
          id: "67890",
          handle: "dcramer-alt",
          display_name: "Alt",
        },
      ],
    });
  });

  it("leaves out a plugin search that fails", async () => {
    await seedLinkedIdentities({
      githubId: "12345",
      githubHandle: "dcramer",
      slackUserId: "U039RR91S",
      slackHandle: "david",
    });
    queueSlackApiResponse("users.list", { body: usersListPage() });
    await createApp({
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "github",
            displayName: "GitHub",
            description: "Fails to search test accounts",
          },
          hooks: {
            searchUsers: () => {
              throw new Error("provider is down");
            },
          },
        }),
      ]),
    });

    await expect(
      executeTool(lookupTool(), { query: "dcramer" }),
    ).resolves.toMatchObject({
      count: 1,
      ambiguous: false,
      user: { id: "U039RR91S", matched_providers: ["github"] },
    });
  });

  it("returns no candidates when nobody matches an exact ID", async () => {
    queueSlackApiError("users.info", { error: "user_not_found" });

    await expect(
      executeTool(lookupTool(), { query: "U0MISSING" }),
    ).resolves.toMatchObject({ count: 0, ambiguous: false, users: [] });
  });
});

// Reads in the first seconds after an Identity write skip the cache.
function passIdentityWriteWindow() {
  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 60_000);
}

describe("readIdentityById", () => {
  it("reads a repeat lookup from the cache without SQL", async () => {
    const slack = await seedLinkedIdentities({
      githubId: "12345",
      githubHandle: "dcramer",
      slackUserId: "U039RR91S",
      slackHandle: "david",
    });
    passIdentityWriteWindow();
    const first = await readIdentityById(slack.id);
    expect(first?.user?.identities).toContainEqual(
      expect.objectContaining({ provider: "github", handle: "dcramer" }),
    );

    const repeat = await measureSql(() => readIdentityById(slack.id));

    expect(repeat.result).toEqual(first);
    expect(repeat.statements).toEqual([]);
  });
});

describe("findLinkedHandle", () => {
  const findGitHubHandle = async (query: string) =>
    await findLinkedHandle({
      egress: {
        fetch: async () => {
          throw new Error("findLinkedHandle tests make no provider requests");
        },
      },
      provider: "github",
      providers: ["slack", "github"],
      query,
      teamId: parseSlackTeamId("T0TEST")!,
    });

  it("returns the linked handle of the person a mention names", async () => {
    await seedLinkedIdentities({
      githubId: "12345",
      githubHandle: "dcramer",
      slackUserId: "U039RR91S",
      slackHandle: "david",
    });
    queueSlackApiResponse("users.info", {
      body: usersInfoOk({ userId: "U039RR91S", userName: "david" }),
    });

    await expect(findGitHubHandle("<@U039RR91S>")).resolves.toEqual({
      status: "found",
      handle: "dcramer",
    });
  });

  it("reports a person with no linked account", async () => {
    queueSlackApiResponse("users.info", {
      body: usersInfoOk({ userId: "U0NOLINK", userName: "nolink" }),
    });

    await expect(findGitHubHandle("<@U0NOLINK>")).resolves.toEqual({
      status: "unlinked",
    });
  });

  it("reports a query that names nobody", async () => {
    queueSlackApiError("users.info", { error: "user_not_found" });

    await expect(findGitHubHandle("U0MISSING")).resolves.toEqual({
      status: "not_found",
    });
  });

  it("answers a repeat lookup from the cache without Slack", async () => {
    await seedLinkedIdentities({
      githubId: "12345",
      githubHandle: "dcramer",
      slackUserId: "U039RR91S",
      slackHandle: "david",
    });
    passIdentityWriteWindow();
    queueSlackApiResponse("users.info", {
      body: usersInfoOk({ userId: "U039RR91S", userName: "david" }),
    });
    const found = { status: "found", handle: "dcramer" };
    await expect(findGitHubHandle("<@U039RR91S>")).resolves.toEqual(found);

    await expect(findGitHubHandle("<@U039RR91S>")).resolves.toEqual(found);
    expect(getCapturedSlackApiCalls("users.info")).toHaveLength(1);
  });

  it("drops the handle on the next lookup after an unlink", async () => {
    const slack = await seedLinkedIdentities({
      githubId: "12345",
      githubHandle: "dcramer",
      slackUserId: "U039RR91S",
      slackHandle: "david",
    });
    passIdentityWriteWindow();
    for (let call = 0; call < 2; call += 1) {
      queueSlackApiResponse("users.info", {
        body: usersInfoOk({ userId: "U039RR91S", userName: "david" }),
      });
    }
    const githubHandle = async () =>
      (await readIdentityById(slack.id))?.user?.identities.find(
        (identity) => identity.provider === "github",
      )?.handle;
    const found = { status: "found", handle: "dcramer" };
    // Both lookups are cached before the unlink.
    await findGitHubHandle("<@U039RR91S>");
    await expect(findGitHubHandle("<@U039RR91S>")).resolves.toEqual(found);
    expect(getCapturedSlackApiCalls("users.info")).toHaveLength(1);
    await githubHandle();
    const cached = await measureSql(githubHandle);
    expect(cached).toMatchObject({ result: "dcramer", statements: [] });
    const tokens = createUserTokenStore();
    await tokens.set("U039RR91S", "github", {
      account: { id: "12345", handle: "dcramer" },
      accessToken: "github-access-token",
      refreshToken: "github-refresh-token",
    });

    await unlinkProvider("U039RR91S", "github", tokens, "T0TEST");

    await expect(findGitHubHandle("<@U039RR91S>")).resolves.toEqual({
      status: "unlinked",
    });
    expect(await githubHandle()).toBeUndefined();
  });

  it("serves the last handle while Slack fails", async () => {
    await seedLinkedIdentities({
      githubId: "12345",
      githubHandle: "dcramer",
      slackUserId: "U039RR91S",
      slackHandle: "david",
    });
    passIdentityWriteWindow();
    queueSlackApiResponse("users.info", {
      body: usersInfoOk({ userId: "U039RR91S", userName: "david" }),
    });
    const found = { status: "found", handle: "dcramer" };
    await expect(findGitHubHandle("<@U039RR91S>")).resolves.toEqual(found);
    // Past the TTL, so the next lookup asks Slack again.
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    queueSlackApiError("users.info", { error: "fatal_error" });

    await expect(findGitHubHandle("<@U039RR91S>")).resolves.toEqual(found);
    expect(getCapturedSlackApiCalls("users.info")).toHaveLength(2);
  });
});
