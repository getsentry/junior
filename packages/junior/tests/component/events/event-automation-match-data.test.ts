import { createMemoryState } from "@chat-adapter/state-memory";
import { githubPlugin } from "@sentry/junior-github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
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
  });

  it("loads filters for event automations with no identifier", async () => {
    const automationId = `evt_any_resource_${Date.now()}`;
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
      await expect(publisher.hasMatch(event("admin"))).resolves.toBe(true);
      await expect(publisher.hasMatch(event("write"))).resolves.toBe(false);
    } finally {
      await deleteEventAutomation(getDb(), automationId);
      vi.unstubAllEnvs();
    }
  });
});
