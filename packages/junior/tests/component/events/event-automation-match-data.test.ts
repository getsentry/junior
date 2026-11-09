import { createMemoryState } from "@chat-adapter/state-memory";
import { githubPlugin } from "@sentry/junior-github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import * as dbModule from "@/chat/db";
import { closeDb, getDb, getSqlExecutor } from "@/chat/db";
import {
  createEventAutomation,
  deleteEventAutomation,
} from "@/chat/event-automations/store";
import { createEventAppPublisher } from "@/chat/events/app-publisher";
import { upsertIdentity } from "@/chat/identities/sql";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { SLACK_DESTINATION } from "../../fixtures/conversation-work";

describe("event automation match data", () => {
  afterEach(async () => {
    await closeDb();
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("loads filters for event automations with no identifier", async () => {
    const automationId = `evt_any_resource_${Date.now()}`;
    const pullRequestAutomationId = `evt_pull_request_${Date.now()}`;
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-event-test");
    try {
      await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
      const creator = await upsertIdentity(getSqlExecutor(), {
        kind: "user",
        provider: "slack",
        providerTenantId: SLACK_DESTINATION.teamId,
        providerSubjectId: "U123",
      });
      await createEventAutomation(getDb(), {
        id: automationId,
        createdAtMs: Date.now(),
        createdBy: { slackUserId: "U123" },
        creatorIdentityId: creator.id,
        credentialMode: "system",
        destination: SLACK_DESTINATION,
        destinationVisibility: "public",
        outcomes: [],
        task: { text: "Review pull requests that admins open." },
        trigger: {
          events: ["pull_request.opened"],
          label: "Admin pull requests in getsentry/junior",
          match: { openerRole: "admin", repo: "getsentry/junior" },
          namespace: "github",
        },
      });
      await createEventAutomation(getDb(), {
        id: pullRequestAutomationId,
        createdAtMs: Date.now(),
        createdBy: { slackUserId: "U123" },
        creatorIdentityId: creator.id,
        credentialMode: "system",
        destination: SLACK_DESTINATION,
        destinationVisibility: "public",
        outcomes: [],
        task: { text: "Review pull request 8." },
        trigger: {
          events: ["pull_request.opened"],
          identifier: "getsentry/junior#8",
          label: "getsentry/junior#8",
          namespace: "github",
          resourceType: "pull_request",
        },
      });
      const publisher = createEventAppPublisher({
        conversationWork: () => ({ state: createMemoryState() }),
      });

      // The plugin loads the opener role only when a filter needs it, and
      // this automation names no resource.
      await expect(
        publisher.neededMatchKeys({
          eventTypes: ["pull_request.opened"],
          identifiers: ["getsentry/junior#7", "getsentry/junior"],
          namespace: "github",
        }),
      ).resolves.toEqual(["openerRole", "repo"]);
      // The plugin passes the repo it already knows. The filter for
      // getsentry/junior fails for another repository, so that repository
      // loads nothing from GitHub.
      await expect(
        publisher.neededMatchKeys({
          data: { repo: "getsentry/sentry" },
          eventTypes: ["pull_request.opened"],
          identifiers: ["getsentry/sentry#7", "getsentry/sentry"],
          namespace: "github",
        }),
      ).resolves.toEqual([]);
      await expect(
        publisher.neededMatchKeys({
          data: { repo: "getsentry/junior" },
          eventTypes: ["pull_request.opened"],
          identifiers: ["getsentry/junior#7", "getsentry/junior"],
          namespace: "github",
        }),
      ).resolves.toEqual(["openerRole", "repo"]);
      await expect(
        publisher.neededMatchKeys({
          eventTypes: ["pull_request.merged"],
          identifiers: ["getsentry/junior#7"],
          namespace: "github",
        }),
      ).resolves.toEqual([]);
      const event = (openerRole: string) => ({
        eventKey: `github:any-resource:${openerRole}`,
        eventType: "pull_request.opened",
        identifier: "getsentry/junior#7",
        namespace: "github",
        occurredAtMs: Date.now(),
        trustedSummary: "A pull request was opened.",
        data: { openerRole, pullRequest: 7, repo: "getsentry/junior" },
      });
      await expect(publisher.hasMatch([event("admin")])).resolves.toBe(true);
      await expect(publisher.hasMatch([event("write")])).resolves.toBe(false);

      // All copies of a webhook Event share one automations read. The
      // automation for #8 does not match the #7 copy, and does not select
      // the merged copy.
      const db = getDb();
      const select = vi.spyOn(db, "select");
      vi.spyOn(dbModule, "getDb").mockReturnValue(db);
      const pullRequest8 = {
        ...event("write"),
        identifier: "getsentry/junior#8",
      };
      await expect(
        publisher.hasMatch([
          event("write"),
          { ...pullRequest8, eventType: "pull_request.merged" },
        ]),
      ).resolves.toBe(false);
      expect(select).toHaveBeenCalledTimes(1);
      await expect(
        publisher.hasMatch([event("write"), pullRequest8]),
      ).resolves.toBe(true);
    } finally {
      await deleteEventAutomation(getDb(), automationId);
      await deleteEventAutomation(getDb(), pullRequestAutomationId);
      vi.unstubAllEnvs();
    }
  });
});
