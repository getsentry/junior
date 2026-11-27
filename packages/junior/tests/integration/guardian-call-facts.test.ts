import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActionFacts, CodeChangeInput } from "@sentry/junior-plugin-api";
import { recordCodeChange } from "@/chat/code/store";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { actionFromFacts } from "@/chat/guardian/call-facts";
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

const edit: ActionFacts = {
  effect: "edit",
  summary: "Update pull request getsentry/junior#691.",
  target: {
    ref: "getsentry/junior#691",
    audience: "world",
    codeChange: { repository: "getsentry/junior", number: 691 },
  },
};

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

  async function created(
    facts: ActionFacts,
    conversationIds: string[],
    provider = "github",
  ) {
    const action = await actionFromFacts(facts, {
      provider,
      conversationIds: async () => conversationIds,
    });
    return action.target?.createdByThisWork;
  }

  it("counts a pull request that this work's code records hold", async () => {
    // A child of the Conversation that opened it is the same work.
    await expect(created(edit, ["agent:child-1", ROOT])).resolves.toBe(true);
  });

  it("does not count a pull request of other work", async () => {
    await expect(created(edit, ["slack:C999:999.999"])).resolves.toBe(false);
  });

  it("does not count another provider's records", async () => {
    await expect(created(edit, [ROOT], "gitlab")).resolves.toBe(false);
  });

  it("does not count a target without a code change", async () => {
    const { codeChange: _codeChange, ...target } = edit.target!;
    await expect(created({ ...edit, target }, [ROOT])).resolves.toBe(false);
  });
});
