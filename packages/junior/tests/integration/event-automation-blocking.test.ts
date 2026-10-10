import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { markDispatchBlocked } from "@/chat/agent-dispatch/store";
import { getConversationStore } from "@/chat/db";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { ingestEventAutomations } from "@/chat/event-automations/ingest";
import { getEventAutomation } from "@/chat/event-automations/store";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { createUpdateEventAutomationTool } from "@/chat/tools/update-event-automation";
import { juniorEventAutomations } from "@/db/schema/event-automations";
import {
  changesRequestedEvent,
  context,
  createTask,
  EVENT_CATALOG,
  execute,
  teamId,
} from "../fixtures/event-automations";
import {
  createConversationWorkQueueTestAdapter,
  type ConversationWorkQueueTestAdapter,
} from "../fixtures/conversation-work";
import { slackApiOutbox } from "../fixtures/slack-api-outbox";
import {
  createConfiguredJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../fixtures/sql";
import {
  getCapturedSlackApiCalls,
  resetSlackApiMockState,
} from "../msw/handlers/slack-api";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
  process.env.JUNIOR_SECRET = "event-automation-test-secret";
});

let fixture: LocalJuniorSqlFixture;
let queue: ConversationWorkQueueTestAdapter;

describe("event automation blocking", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
    resetSlackApiMockState();
    fixture = createConfiguredJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    queue = createConversationWorkQueueTestAdapter();
    // The automation tools save cards to the creation Conversation.
    await getConversationStore().recordActivity({
      conversationId: "test:event-annotations",
      destination: {
        platform: "local",
        conversationId: "test:event-annotations",
      },
      source: "local",
      nowMs: Date.now(),
    });
  });

  afterEach(async () => {
    await fixture.sql
      .db()
      .delete(juniorEventAutomations)
      .where(eq(juniorEventAutomations.teamId, teamId));
    await fixture.close();
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("blocks an event automation after a blocked run and tells its creator once", async () => {
    const { automation } = await createTask("Add the release-train label.");
    const reason = "This run needs a connected github account.";
    const db = fixture.sql.db();
    const read = async () => (await getEventAutomation(db, automation.id))!;
    // The creator resumes or pauses it from chat.
    const setStatus = (status: "active" | "paused") =>
      execute(createUpdateEventAutomationTool(context(), EVENT_CATALOG), {
        automationId: automation.id,
        status,
      });
    const ingest = (eventKey: string) =>
      ingestEventAutomations(changesRequestedEvent(eventKey), {
        queue,
        teamId,
      });
    // The work owner blocks the dispatch when a run cannot get authorization.
    const blockRun = (index: number) =>
      markDispatchBlocked(
        queue
          .sentRecords()
          [index]!.conversationId!.replace(/^agent-dispatch:/, ""),
        reason,
      );

    expect(await ingest("github:blocked-1")).toEqual({ dispatched: 1 });
    // A redelivered block must not notify the creator again.
    await blockRun(0);
    await blockRun(0);

    // Nothing posts to the Destination. The creator gets one private notice.
    expect(
      getCapturedSlackApiCalls("conversations.open").map(
        ({ params }) => params.users,
      ),
    ).toEqual(["U123"]);
    expect(
      slackApiOutbox.messages().map(({ params }) => ({
        channel: params.channel,
        text: params.text,
      })),
    ).toEqual([
      {
        channel: expect.stringMatching(/^D/),
        text: expect.stringContaining(reason),
      },
    ]);
    expect(await read()).toMatchObject({
      status: "blocked",
      statusReason: reason,
    });
    expect(await ingest("github:blocked-2")).toEqual({ dispatched: 0 });

    // Another person in the channel cannot resume it.
    await expect(
      execute(createUpdateEventAutomationTool(context("U999"), EVENT_CATALOG), {
        automationId: automation.id,
        status: "active",
      }),
    ).rejects.toThrow("Only the creator");
    expect(await read()).toMatchObject({ status: "blocked" });

    await setStatus("active");
    expect(await read()).toMatchObject({ status: "active" });
    expect(await read()).not.toHaveProperty("statusReason");
    expect(await ingest("github:blocked-3")).toEqual({ dispatched: 1 });

    // The creator pauses it while that run is in flight. The run blocks, so
    // the reason stays and resume returns the automation to blocked.
    await setStatus("paused");
    await blockRun(1);
    expect(await read()).toMatchObject({
      status: "paused",
      statusReason: reason,
    });
    // The dashboard shows paused, so no second notice says blocked.
    expect(getCapturedSlackApiCalls("conversations.open")).toHaveLength(1);
    await setStatus("active");
    expect(await read()).toMatchObject({
      status: "blocked",
      statusReason: reason,
    });
  });
});
