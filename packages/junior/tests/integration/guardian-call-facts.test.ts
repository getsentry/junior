import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodeChangeInput } from "@sentry/junior-plugin-api";
import { recordCodeChange } from "@/chat/code/store";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import {
  actionFromDescription,
  describeContext,
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

  function isOwn(conversationIds: string[], provider = "github", number = 691) {
    return describeContext({
      provider,
      conversationIds: async () => conversationIds,
    }).isOwnPullRequest("getsentry/junior", number);
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

  it("keeps the tool's advice and its reason on the action", () => {
    expect(
      actionFromDescription({
        ref: "getsentry/junior#691",
        audience: "world",
        advice: "allow",
        reason: "Only the text of this work's pull request changes.",
      }),
    ).toEqual({
      target: { ref: "getsentry/junior#691", audience: "world" },
      advice: {
        decision: "allow",
        reason: "Only the text of this work's pull request changes.",
      },
    });
  });
});
