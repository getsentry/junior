import { describe, expect, it } from "vitest";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { createApp, defineJuniorPlugins } from "@/app";
import { usersInfoOk, usersListPage } from "../fixtures/slack/factories/api";
import {
  executeTool,
  lookupTool,
  seedLinkedIdentities,
} from "../fixtures/user-lookup";
import {
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
