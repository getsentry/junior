import { CONVERSATION_DETAIL_VERSION_HEADER } from "@/api/schema";
import { afterEach, describe, expect, it } from "vitest";
import { avatarPath } from "../../../fixtures/avatar";
import { signedInViewer } from "../../../fixtures/user";
import { githubPlugin } from "@sentry/junior-github";
import { encodeObjectImageRef } from "@sentry/junior-plugin-api";
import { createJuniorApi } from "@/api";
import { createApp, defineJuniorPlugins } from "@/app";
import { decodeImageId } from "@/chat/images/ids";
import { conversationDetailReportSchema } from "@/api/schema";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { storeAttachment } from "@/chat/attachments/store";
import {
  closeDb,
  getDb,
  getConversationEventStore,
  getConversationStore,
  getSqlExecutor,
} from "@/chat/db";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { readConversationDetail } from "@/api/conversations/detail";
import { appendConversationBrief } from "@/chat/briefs/store";
import { conversationBriefFixture } from "../../../fixtures/conversation-brief";
import { usersInfoOk } from "../../../fixtures/slack/factories/api";
import { juniorIdentities } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import {
  getCapturedSlackApiCalls,
  queueSlackApiResponse,
} from "../../../msw/handlers/slack-api";
import { getStateAdapter } from "@/chat/state/adapter";
import {
  createChild,
  insertLegacyEvent,
} from "../../../fixtures/dashboard-reporting";

describe("conversation detail API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("returns newly appended events when refreshed", async () => {
    const conversationId = "local:test:refreshed-detail";
    await getConversationStore().recordActivity({
      destination: { platform: "local" as const, conversationId },
      conversationId,
      nowMs: 1,
      source: "internal",
      title: "Refreshed conversation",
      visibility: "public",
    });
    await appendConversationBrief(getDb(), {
      conversationId,
      turnId: "brief-turn",
      throughSeq: 0,
      content: conversationBriefFixture({
        summary: "The public Brief is visible without transcript access.",
      }),
      searchText: "public Brief visible",
      modelId: "test-model",
    });

    const app = createJuniorApi();
    const detailResponse = await app.request(
      `http://localhost/api/conversations/${conversationId}`,
    );
    const detail = conversationDetailReportSchema.parse(
      await detailResponse.json(),
    );
    expect(detail.events).toEqual([]);
    expect(detail.brief).toMatchObject({
      content: {
        summary: "The public Brief is visible without transcript access.",
      },
      version: 1,
    });

    await getConversationEventStore().append(conversationId, [
      {
        createdAtMs: 2,
        data: {
          messageId: "first-message",
          role: "assistant",
          text: "first-message",
          type: "message",
        },
      },
      {
        createdAtMs: 3,
        data: {
          content: { costUsd: 0.0004, memories: [] },
          name: "memories_recalled",
          namespace: "memory",
          type: "structured_event",
          version: 1,
        },
      },
    ]);
    // Turns routed before the Turn router was retired keep their router cost.
    await insertLegacyEvent(conversationId, {
      createdAtMs: 4,
      data: {
        confidence: 0.9,
        costUsd: 0.0002,
        modelId: "openai/gpt-5-mini",
        modelProfile: "standard",
        reasoningLevel: "medium",
        source: "router",
        turnId: "turn-1",
        type: "turn_routed",
      },
    });
    // Background and active summaries are one compaction operation. The swap
    // of a prepared summary makes no model call, so it adds no cost.
    await getConversationEventStore().append(conversationId, [
      {
        createdAtMs: 5,
        data: {
          costUsd: 0.0003,
          historyVersion: 0,
          markSeq: 0,
          modelId: "test-model",
          outcome: "ready",
          summary: "Prepared summary.",
          type: "compaction_prepared",
        },
      },
    ]);
    await getConversationEventStore().replaceHistory(conversationId, {
      createdAtMs: 6,
      data: {
        modelId: "test-model",
        replacementHistory: [],
        summary: "Prepared summary.",
        type: "compaction",
      },
    });
    await getConversationEventStore().replaceHistory(conversationId, {
      createdAtMs: 7,
      data: {
        costUsd: 0.0001,
        modelId: "test-model",
        replacementHistory: [],
        summary: "Active summary.",
        type: "compaction",
      },
    });
    const refreshedResponse = await app.request(
      `http://localhost/api/conversations/${conversationId}`,
    );
    const refreshed = conversationDetailReportSchema.parse(
      await refreshedResponse.json(),
    );
    expect(refreshed.events.map((event) => event.data.type)).toEqual([
      "message",
      "compaction",
      "compaction",
    ]);
    expect(refreshed.auxiliaryCosts).toEqual({
      costUsd: 0.001,
      operations: [
        {
          costUsd: 0.0004,
          events: 2,
          name: "compaction",
          namespace: "junior",
        },
        {
          costUsd: 0.0002,
          events: 1,
          name: "turn_routed",
          namespace: "junior",
        },
        {
          costUsd: 0.0004,
          events: 1,
          name: "memories_recalled",
          namespace: "memory",
        },
      ],
    });
  });

  it("returns only newer events to a poll until stored events project differently", async () => {
    const conversationId = "local:test:appended-detail";
    await getConversationStore().recordActivity({
      destination: { platform: "local" as const, conversationId },
      conversationId,
      nowMs: 1,
      source: "internal",
      title: "Appended conversation",
      visibility: "public",
    });
    const appendMessage = (messageId: string, createdAtMs: number) =>
      getConversationEventStore().append(conversationId, [
        {
          createdAtMs,
          data: {
            messageId,
            role: "assistant",
            text: messageId,
            type: "message",
          },
        },
      ]);
    const app = createJuniorApi();
    const read = async (query = "") =>
      conversationDetailReportSchema.parse(
        await (
          await app.request(
            `http://localhost/api/conversations/${conversationId}${query}`,
          )
        ).json(),
      );
    const after = (cursor: string | undefined) =>
      `after=${encodeURIComponent(cursor!)}`;
    const seqs = (report: { events: { seq: number }[] }) =>
      report.events.map((event) => event.seq);

    await appendMessage("first", 2);
    const first = await read();
    expect(seqs(first)).toEqual([0]);
    expect(first.appended).toBeUndefined();

    await appendMessage("second", 3);
    const poll = await read(`?${after(first.appendCursor)}`);
    expect(poll.appended).toBe(true);
    expect(seqs(poll)).toEqual([1]);
    const idle = await read(`?${after(poll.appendCursor)}`);
    expect(idle).toMatchObject({ appended: true, events: [] });
    expect(idle.appendCursor).toBe(poll.appendCursor);

    // A stored Slack file can attach to a message that the reader already
    // has, so the poll gets the latest page again.
    await storeAttachment({
      conversationId,
      db: getSqlExecutor(),
      file: {
        data: Buffer.from("notes"),
        filename: "notes.txt",
        mimeType: "text/plain",
        source: { provider: "slack", id: "FNOTES" },
      },
      storage: createMemoryAttachmentStorage(),
    });
    const changed = await read(`?${after(poll.appendCursor)}`);
    expect(changed.appended).toBeUndefined();
    expect(seqs(changed)).toEqual([0, 1]);

    // A reader more than a page behind gets the latest page.
    await appendMessage("third", 4);
    await appendMessage("fourth", 5);
    const behind = await read(`?limit=1&${after(changed.appendCursor)}`);
    expect(behind.appended).toBeUndefined();
    expect(seqs(behind)).toEqual([3]);
    expect(behind.previousCursor).toBeDefined();
  });

  it("answers unchanged polls with 304 until the subtree or annotations change", async () => {
    const conversationId = "local:test:revalidated-detail";
    const childConversationId = "local:test:revalidated-detail:child";
    await getConversationStore().recordActivity({
      destination: { platform: "local" as const, conversationId },
      conversationId,
      nowMs: 1,
      source: "internal",
      title: "Revalidated conversation",
      visibility: "public",
    });
    const app = createJuniorApi();
    const poll = (etag?: string) =>
      app.request(`http://localhost/api/conversations/${conversationId}`, {
        headers: etag ? { [CONVERSATION_DETAIL_VERSION_HEADER]: etag } : {},
      });

    const first = await poll();
    const firstEtag = first.headers.get(CONVERSATION_DETAIL_VERSION_HEADER)!;
    expect(first.status).toBe(200);
    const unchanged = await poll(firstEtag);
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    // The mailbox changes apart from the version token, so a poll that asks
    // for it gets the mailbox without the report.
    const withMailbox = await app.request(
      `http://localhost/api/conversations/${conversationId}?mailbox=true`,
      { headers: { [CONVERSATION_DETAIL_VERSION_HEADER]: firstEtag } },
    );
    expect(withMailbox.status).toBe(200);
    expect(withMailbox.headers.get(CONVERSATION_DETAIL_VERSION_HEADER)).toBe(
      firstEtag,
    );
    expect(await withMailbox.json()).toEqual({
      mailbox: expect.objectContaining({ conversationId, messages: [] }),
      unchanged: true,
    });

    await createChild({
      childConversationId,
      parentConversationId: conversationId,
    });
    const withChild = await poll(firstEtag);
    const childEtag = withChild.headers.get(
      CONVERSATION_DETAIL_VERSION_HEADER,
    )!;
    expect(withChild.status).toBe(200);
    expect(childEtag).not.toBe(firstEtag);

    // A child agent writes only its own row. The parent still revalidates.
    await getConversationEventStore().append(childConversationId, [
      {
        createdAtMs: 5,
        data: {
          messageId: "child-message",
          role: "assistant",
          text: "child-message",
          type: "message",
        },
      },
    ]);
    const childChanged = await poll(childEtag);
    const childChangedEtag = childChanged.headers.get(
      CONVERSATION_DETAIL_VERSION_HEADER,
    )!;
    expect(childChanged.status).toBe(200);

    await createPluginAnnotations({
      conversationId,
      db: getDb(),
      plugin: "github",
    }).upsert({
      kind: "resource_link",
      key: "getsentry/junior#1",
      label: "getsentry/junior #1",
      url: "https://github.com/getsentry/junior/pull/1",
    });
    expect((await poll(childChangedEtag)).status).toBe(200);
  });

  it("titles an untitled conversation from its first human message", async () => {
    const conversationId = "local:test:untitled-detail";
    await getConversationStore().recordActivity({
      destination: { platform: "local" as const, conversationId },
      conversationId,
      nowMs: 1,
      source: "web",
      visibility: "public",
    });
    await expect(readConversationDetail(conversationId)).resolves.toMatchObject(
      { displayTitle: "API" },
    );

    await getConversationEventStore().append(conversationId, [
      {
        createdAtMs: 2,
        data: {
          messageId: "bot-message",
          meta: { author: { isBot: true } },
          role: "user",
          text: "Bot input is not a title",
          type: "message",
        },
      },
      {
        createdAtMs: 3,
        data: {
          messageId: "human-message",
          role: "user",
          text: "\n  Review this PR and check the failing tests\nMore context",
          type: "message",
        },
      },
    ]);
    // While generation runs, the title is the first line of the human message.
    await expect(readConversationDetail(conversationId)).resolves.toMatchObject(
      { displayTitle: "Review this PR and check the failing tests" },
    );

    await getConversationStore().recordActivity({
      conversationId,
      nowMs: 4,
      title: "Review failing PR tests",
    });
    await expect(readConversationDetail(conversationId)).resolves.toMatchObject(
      { displayTitle: "Review failing PR tests" },
    );
  });

  it("only returns annotations to viewers with private-content access", async () => {
    const conversationId = "slack:C-private:annotated-detail";
    await getConversationStore().recordActivity({
      actor: {
        email: "Participant@Example.com",
        platform: "slack",
        slackUserId: "U-participant",
        teamId: "TPRIVATE",
      },
      conversationId,
      destination: {
        channelId: "CPRIVATE",
        platform: "slack",
        teamId: "TPRIVATE",
      },
      nowMs: 1,
      source: "slack",
      title: "Private annotated conversation",
      visibility: "private",
    });
    const annotations = createPluginAnnotations({
      conversationId,
      db: getDb(),
      plugin: "github",
    });
    await annotations.upsert({
      kind: "resource_link",
      key: "getsentry/junior#1081",
      label: "getsentry/junior #1081",
      status: "open",
      url: "https://github.com/getsentry/junior/pull/1081",
    });
    await appendConversationBrief(getDb(), {
      conversationId,
      turnId: "private-brief-turn",
      throughSeq: 0,
      content: conversationBriefFixture({
        summary: "The private Brief is participant-only.",
      }),
      searchText: "private Brief participant only",
      modelId: "test-model",
    });

    const hidden = await readConversationDetail(conversationId);
    expect(hidden).toMatchObject({
      annotations: [],
      eventHistory: { status: "redacted" },
    });
    expect(hidden).not.toHaveProperty("brief");
    await expect(
      readConversationDetail(conversationId, {
        viewer: await signedInViewer("participant@example.com"),
      }),
    ).resolves.toMatchObject({
      brief: {
        content: { summary: "The private Brief is participant-only." },
        version: 1,
      },
      annotations: [
        {
          key: "getsentry/junior#1081",
          kind: "resource_link",
          label: "getsentry/junior #1081",
          plugin: "github",
          status: "open",
          url: "https://github.com/getsentry/junior/pull/1081",
        },
      ],
      eventHistory: { status: "available" },
    });
  });

  it("names the description images of a saved pull request by Junior image paths", async () => {
    await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
    const conversationId = "local:test:preview-images";
    await getConversationStore().recordActivity({
      destination: { platform: "local" as const, conversationId },
      conversationId,
      nowMs: 1,
      source: "internal",
      title: "Pull request with screenshots",
      visibility: "public",
    });
    const attachment =
      "https://github.com/user-attachments/assets/0f8c2d6e-5a4b-4c3d-9e8f-7a6b5c4d3e2f";
    await createPluginAnnotations({
      conversationId,
      db: getDb(),
      plugin: "github",
    }).upsert({
      kind: "object",
      objectType: "code_change",
      key: "getsentry/secret#7",
      label: "getsentry/secret#7",
      title: "Show screenshots on cards",
      url: "https://github.com/getsentry/secret/pull/7",
      facts: { type: "code_change", previewImageUrls: [attachment] },
    });

    const detail = await readConversationDetail(conversationId);
    const [image] = detail?.annotations?.[0]?.previewImages ?? [];
    const id = image?.src.match(/^\/api\/images\/([^?]+)\?w=320$/)?.[1];
    expect(image?.srcSet).toBe(`${image?.src} 1x, /api/images/${id}?w=640 2x`);
    // The browser gets a signed id, never the address of the image.
    expect(JSON.stringify(image)).not.toContain("user-attachments");
    expect(id && decodeImageId(id)).toEqual({
      ref: encodeObjectImageRef({ key: "getsentry/secret#7", url: attachment }),
      source: "github",
    });
  });

  it("resolves mentioned Slack users with current names", async () => {
    const conversationId = "slack:C123:mentions-detail";
    await getConversationStore().recordActivity({
      actor: {
        email: "owner@example.com",
        fullName: "Owner Person",
        platform: "slack",
        slackUserId: "UOWNER1",
        teamId: "T123",
      },
      conversationId,
      destination: { channelId: "C123", platform: "slack", teamId: "T123" },
      nowMs: 1,
      source: "slack",
      title: "Mentions",
      visibility: "public",
    });
    queueSlackApiResponse("users.info", {
      body: usersInfoOk({
        userId: "UNEW1234",
        userName: "new.person",
        realName: "New Person",
      }),
    });
    await getConversationEventStore().append(conversationId, [
      {
        // Gives UNEW1234 a Junior identity with no name.
        createdAtMs: 2,
        data: {
          messageId: "user-1",
          meta: { author: { userId: "UNEW1234" } },
          role: "user",
          text: "ship it",
          type: "message",
        },
      },
      {
        createdAtMs: 3,
        data: {
          messageId: "reply-1",
          role: "assistant",
          text: "<@UOWNER1> merged. cc <@UNEW1234> <@USHARED1>",
          type: "message",
        },
      },
    ]);
    // Another instance already asked Slack for USHARED1.
    await getStateAdapter().set(
      "slack-user-names:T123:USHARED1",
      { fullName: "Shared Person" },
      60_000,
    );
    await appendConversationBrief(getDb(), {
      conversationId,
      turnId: "mentions-brief-turn",
      throughSeq: 1,
      content: conversationBriefFixture({
        summary: "<@UOWNER1> merged the fix.",
      }),
      searchText: "owner merged the fix",
      modelId: "test-model",
    });

    const detail = await readConversationDetail(conversationId, {
      viewer: await signedInViewer("owner@example.com"),
    });
    const message = detail?.events.find(
      (event) =>
        event.data.type === "message" && event.data.messageId === "reply-1",
    );
    expect(message).toMatchObject({
      mentions: [
        // Known Junior users link to their People profile.
        {
          email: "owner@example.com",
          fullName: "Owner Person",
          slackUserId: "UOWNER1",
        },
        // A user with no name in Junior gets one from Slack, but no link.
        {
          fullName: "New Person",
          slackUserId: "UNEW1234",
          slackUserName: "new.person",
        },
        { fullName: "Shared Person", slackUserId: "USHARED1" },
      ],
    });
    expect(
      getCapturedSlackApiCalls("users.info").map((call) => call.params.user),
    ).toEqual(["UNEW1234"]);
    // Other instances can now skip Slack for UNEW1234.
    expect(
      await getStateAdapter().get("slack-user-names:T123:UNEW1234"),
    ).toEqual({ fullName: "New Person", userName: "new.person" });
    // The Brief uses the same lookup as transcript events.
    expect(detail?.brief?.mentions).toEqual([
      {
        email: "owner@example.com",
        fullName: "Owner Person",
        slackUserId: "UOWNER1",
      },
    ]);
  });

  it("names the participant who wrote each message", async () => {
    const conversationId = "slack:C123:author-photos";
    await getConversationStore().recordActivity({
      actor: {
        email: "owner@example.com",
        fullName: "Owner Person",
        platform: "slack",
        slackUserId: "UOWNER1",
        teamId: "T123",
      },
      conversationId,
      destination: { channelId: "C123", platform: "slack", teamId: "T123" },
      nowMs: 1,
      source: "slack",
      title: "Author photos",
      visibility: "public",
    });
    const [owner] = await getDb()
      .update(juniorIdentities)
      .set({ avatarUrl: "https://avatars.slack-edge.com/owner_512.png" })
      .where(
        and(
          eq(juniorIdentities.provider, "slack"),
          eq(juniorIdentities.providerSubjectId, "UOWNER1"),
        ),
      )
      .returning({ id: juniorIdentities.id, userId: juniorIdentities.userId });
    // The same person can send next from the web before history has it.
    await getDb()
      .insert(juniorIdentities)
      .values({
        id: "identity-owner-google",
        createdAt: new Date(1_000),
        kind: "user",
        provider: "google",
        providerSubjectId: "google-owner",
        updatedAt: new Date(1_000),
        userId: owner!.userId,
      });
    await getConversationEventStore().append(conversationId, [
      {
        createdAtMs: 2,
        data: {
          authorIdentityId: owner!.id,
          messageId: "owner-1",
          meta: { author: { fullName: "Owner Person", userId: "UOWNER1" } },
          role: "user",
          text: "ship it",
          type: "message",
        },
      },
    ]);

    const detail = await readConversationDetail(conversationId, {
      viewer: await signedInViewer("owner@example.com"),
    });
    // Messages name their author. The detail carries each author once.
    expect(detail?.events[0]?.data).toMatchObject({
      actorIdentityId: owner!.id,
    });
    expect(detail?.events[0]?.data).not.toHaveProperty(
      "actorIdentity.avatarUrl",
    );
    expect(detail?.authors?.[owner!.id]).toMatchObject({
      avatarUrl: avatarPath(owner!.id),
      fullName: "Owner Person",
      slackUserId: "UOWNER1",
    });
    expect(detail?.authors?.["identity-owner-google"]).toEqual(
      detail?.authors?.[owner!.id],
    );
  });

  it("links a viewer-visible source task from a terminal execution", async () => {
    const { createConfiguredJuniorSqlFixture } =
      await import("../../../fixtures/sql");
    const { migrateSchema } =
      await import("@/chat/conversations/sql/migrations");
    const { createSqlStore } = await import("@/chat/conversations/sql/store");
    const { resolveViewerUserFromSql } = await import("@/chat/plugins/viewer");
    const { saveScheduledAutomation } =
      await import("@/chat/scheduled-automations/tasks");
    const { recordAutomationExecution } =
      await import("@/chat/automations/execution-stats");
    const { createAgentDispatchTestRecord } =
      await import("../../../fixtures/agent-dispatch");
    const { getDispatchConversationId } =
      await import("@/chat/agent-dispatch/store");
    const { bindScheduledAutomationCredentialSubject } =
      await import("@/chat/credentials/subject");
    const fixture = createConfiguredJuniorSqlFixture();
    const conversationStore = createSqlStore(fixture.sql);
    try {
      await migrateSchema(fixture.sql);
      const dispatch = await createAgentDispatchTestRecord(
        "source-task-detail",
        bindScheduledAutomationCredentialSubject({
          plugin: "scheduler",
          subject: {
            type: "user",
            userId: "U123",
            allowedWhen: "scheduled-automation",
            taskId: "sched_source_task",
          },
        }),
      );
      const conversationId = getDispatchConversationId(dispatch);
      await conversationStore.recordActivity({
        conversationId,
        actor: {
          email: "viewer@example.com",
          platform: "slack",
          slackUserId: "U123",
          teamId: "T123",
        },
        destination: {
          channelId: "C123",
          platform: "slack",
          teamId: "T123",
        },
        channelName: "project-updates",
        nowMs: 1,
        // The run's own title is unset, as while title generation runs.
        source: "plugin",
        visibility: "public",
      });
      const user = await resolveViewerUserFromSql(
        fixture.sql.db(),
        "viewer@example.com",
      );
      const identity = user?.identities.find(
        (candidate) =>
          candidate.provider === "slack" &&
          candidate.providerTenantId === "T123" &&
          candidate.providerSubjectId === "U123",
      );
      expect(identity).toBeDefined();
      const nowMs = 2;
      await saveScheduledAutomation(fixture.sql.db(), {
        id: "sched_source_task",
        conversationAccess: { audience: "channel", visibility: "public" },
        createdAtMs: nowMs,
        createdBy: { fullName: "Viewer Person", slackUserId: "U123" },
        creatorIdentityId: identity!.id,
        credentialMode: "creator",
        destination: {
          channelId: "C123",
          platform: "slack",
          teamId: "T123",
        },
        nextRunAtMs: nowMs + 60_000,
        outcomes: [],
        schedule: {
          description: "Every Monday at 9:00 AM",
          kind: "recurring",
          recurrence: {
            frequency: "weekly",
            interval: 1,
            startDate: "2026-08-03",
            time: { hour: 9, minute: 0 },
            weekdays: [1],
          },
          timezone: "UTC",
        },
        status: "active",
        task: {
          kind: "instruction",
          instruction: "Send the weekly project summary",
        },
        title: "Weekly project summary",
        updatedAtMs: nowMs,
      });
      // Before a source Automation is linked, the API uses its generic run label.
      await expect(
        readConversationDetail(conversationId, { viewer: user! }),
      ).resolves.toMatchObject({ displayTitle: "Automation run" });
      await recordAutomationExecution("sched_source_task", {
        conversationId,
        executionId: "run_source_task",
        nowMs: nowMs + 1,
        status: "completed",
      });

      await expect(
        readConversationDetail(conversationId, {
          viewer: user!,
        }),
      ).resolves.toMatchObject({
        // The API names an untitled run after its source Automation.
        displayTitle: "Weekly project summary",
        sourceTask: {
          id: "sched_source_task",
          kind: "scheduled",
          label: "Send the weekly project summary",
          title: "Weekly project summary",
          triggerMessageId: conversationId,
          triggerLabel: "Every Monday at 9:00 AM",
          credentialMode: "creator",
          credentialUser: "Viewer Person",
        },
      });
      await expect(
        readConversationDetail(conversationId),
      ).resolves.toMatchObject({
        sourceTask: { kind: "scheduled", triggerMessageId: conversationId },
      });
      const hidden = await readConversationDetail(conversationId);
      expect(hidden?.sourceTask).not.toHaveProperty("id");
      expect(hidden?.sourceTask).not.toHaveProperty("label");
      expect(hidden?.sourceTask).not.toHaveProperty("credentialUser");
    } finally {
      await fixture.close();
    }
  });
});
