import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodeChangeInput } from "@sentry/junior-plugin-api";
import { recordCodeChange } from "@/chat/code/store";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import {
  actionFromGuardian,
  guardianContext,
} from "@/chat/guardian/call-facts";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";

const ROOT = "slack:C123:123.456";

const ownPullRequest = {
  conversationIds: [ROOT],
  number: 691,
  openedAt: new Date("2026-01-01T00:00:00Z"),
  providerId: "9001",
  repository: { name: "getsentry/junior", providerId: "42" },
  state: "open",
  title: "fix: Keep the last row",
  updatedAt: new Date("2026-01-01T00:00:00Z"),
} satisfies CodeChangeInput;

describe("Guardian call facts", () => {
  let fixture: ReturnType<typeof createConfiguredJuniorSqlFixture>;

  beforeEach(async () => {
    fixture = createConfiguredJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    await recordCodeChange(fixture.sql.db(), "github", ownPullRequest);
  });

  afterEach(async () => {
    await fixture.close();
  });

  async function isOwn(
    conversationIds: string[],
    plugin = "github",
    number = 691,
  ) {
    const ctx = guardianContext({
      plugin,
      conversationIds: async () => conversationIds,
    });
    const changes = await ctx.codeChanges.list({
      conversationIds: await ctx.conversationIds(),
      repository: { name: "getsentry/junior", numbers: [number] },
    });
    return changes.length > 0;
  }

  it("counts a pull request that this work's code records hold", async () => {
    // A child of the Conversation that opened it is the same work.
    await expect(isOwn(["agent:child-1", ROOT])).resolves.toBe(true);
  });

  it("does not count a pull request of other work", async () => {
    await expect(isOwn(["slack:C999:999.999"])).resolves.toBe(false);
  });

  it("does not count another provider's records", async () => {
    await expect(isOwn([ROOT], "gitlab")).resolves.toBe(false);
  });

  it("does not count another pull request of the repository", async () => {
    await expect(isOwn([ROOT], "github", 692)).resolves.toBe(false);
  });

  it("keeps the tool's decision and its reason on the action", () => {
    expect(
      actionFromGuardian({
        target: "getsentry/junior#691",
        audience: "world",
        decision: "allow",
        reason: "Only the text of this work's pull request changes.",
      }),
    ).toEqual({
      target: { ref: "getsentry/junior#691", audience: "world" },
      toolDecision: {
        decision: "allow",
        reason: "Only the text of this work's pull request changes.",
      },
    });
  });
});
