import {
  claimDueScheduledRun,
  advanceScheduledAutomationAfterRun,
} from "@/chat/scheduled-automations/runs";
import { ingestEventAutomations } from "@/chat/event-automations/ingest";
import { createConversationWorkQueueTestAdapter } from "../../fixtures/conversation-work";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { githubPlugin } from "@sentry/junior-github";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { automationEditSchema } from "@/api/schema/automation";
import { getDb, getConversationStore } from "@/chat/db";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import {
  createEventAutomation,
  getEventAutomation,
} from "@/chat/event-automations/store";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import {
  readScheduledAutomation,
  saveScheduledAutomation,
} from "@/chat/scheduled-automations/tasks";
import { createSlackScheduleUpdateAutomationTool } from "@/chat/scheduled-automations/tools/update";
import { createUpdateEventAutomationTool } from "@/chat/tools/update-event-automation";
import { recordAutomationExecution } from "@/chat/automations/execution-stats";
import { getCapturedSlackApiCalls } from "../../msw/handlers/slack-api";
import {
  execute,
  context as eventContext,
} from "../../fixtures/event-automations";
import { createConfiguredJuniorSqlFixture } from "../../fixtures/sql";

const destination = {
  platform: "slack" as const,
  channelId: "C123",
  teamId: "T123",
};
const originalInstruction = "Post the weekly issue digest.";

async function setup(kind: "scheduled" | "event") {
  const fixture = createConfiguredJuniorSqlFixture();
  await migrateSchema(fixture.sql);
  for (const [slackUserId, email, teamId] of [
    ["U123", "creator@example.com", "T123"],
    ["U456", "reader@example.com", "T123"],
    ["U123", "foreign@example.com", "TFOREIGN"],
  ]) {
    await getConversationStore().recordActivity({
      conversationId: `slack:${teamId}:${slackUserId}:edit`,
      actor: { platform: "slack", slackUserId, email, teamId },
      destination: { ...destination, teamId },
      channelName: "automations",
      visibility: "public",
    });
  }
  const user = await resolveViewerUser("creator@example.com");
  if (!user) throw new Error("Missing creator");
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    const viewer = await resolveViewerUser(
      context.req.header("test-viewer") ?? user.email,
    );
    if (!viewer) throw new Error("Missing viewer");
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  const id = `${kind}_edit_api`;
  const common = {
    id,
    createdAtMs: Date.now(),
    createdBy: { slackUserId: "U123" },
    credentialMode: "creator" as const,
    destination,
    task: { text: originalInstruction },
    title: "My custom title",
    // Keep an existing Destination that the new editor cannot create.
    outcomes: [
      {
        action: "send_message" as const,
        destination: { ...destination, channelId: "DRETAINED" },
      },
    ],
  };
  if (kind === "scheduled") {
    await saveScheduledAutomation(getDb(), {
      ...common,
      creatorIdentityId: user.identities.find(
        (identity) => identity.provider === "slack",
      )!.id,
      conversationAccess: { audience: "channel", visibility: "public" },
      updatedAtMs: Date.now(),
      status: "blocked",
      statusReason: "Missing credentials",
      nextRunAtMs: Date.now() + 86400000,
      schedule: {
        kind: "recurring",
        timezone: "UTC",
        description: "Every day",
        recurrence: {
          frequency: "daily",
          interval: 1,
          time: { hour: 9, minute: 0 },
          startDate: "2026-01-01",
        },
      },
    });
  } else {
    await createEventAutomation(getDb(), {
      ...common,
      destinationVisibility: "public",
      trigger: {
        namespace: "unavailable",
        resourceType: "issue",
        identifier: "issue-42",
        label: "Old issue",
        events: ["issue.closed"],
        match: { retainedCondition: ["one", "two"] },
      },
    });
  }
  const url = `/api/automations/${kind}/${id}`;
  const read = async () => {
    const response = await app.request(`${url}/edit`);
    expect(response.status).toBe(200);
    return automationEditSchema.parse(await response.json());
  };
  const patch = (body: unknown, viewer = user.email) =>
    app.request(url, {
      method: "PATCH",
      headers: { "content-type": "application/json", "test-viewer": viewer },
      body: JSON.stringify(body),
    });
  return { app, fixture, id, url, read, patch, user };
}

describe("Automation edit API", () => {
  afterEach(() => {
    setPlugins([]);
    vi.unstubAllEnvs();
  });

  // Both trigger types are always run by this table; branches exercise their distinct dispatch boundaries.
  /* oxlint-disable vitest/no-conditional-expect */
  test.each(["scheduled", "event"] as const)(
    "pauses and resumes %s work without changing authority or history",
    async (kind) => {
      const { app, fixture, id, url, read, patch } = await setup(kind);
      try {
        if (kind === "scheduled") {
          const task = (await readScheduledAutomation(getDb(), id))!;
          await saveScheduledAutomation(getDb(), {
            ...task,
            status: "active",
            statusReason: undefined,
            nextRunAtMs: Date.now() - 1000,
          });
        }
        await recordAutomationExecution(kind, id, {
          executionId: "past-failure",
          status: "failed",
          nowMs: Date.now() - 5000,
        });
        const initial = await read();
        const lifecycle = (
          action: string,
          revision: string,
          viewer = "creator@example.com",
        ) =>
          app.request(`${url}/lifecycle`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "test-viewer": viewer,
            },
            body: JSON.stringify({ action, revision }),
          });
        expect(
          (await lifecycle("pause", initial.revision, "reader@example.com"))
            .status,
        ).toBe(404);
        expect(
          (await lifecycle("pause", initial.revision, "foreign@example.com"))
            .status,
        ).toBe(404);
        expect((await lifecycle("pause", initial.revision)).status).toBe(200);
        const paused = await read();
        expect(paused).toMatchObject({
          status: "paused",
          credentialMode: "creator",
          outcomes: initial.outcomes,
        });
        expect(
          (
            await patch({
              kind,
              revision: initial.revision,
              instruction: "Stale edit",
            })
          ).status,
        ).toBe(409);
        const listed = await app.request("/api/automations?state=paused");
        expect(await listed.json()).toMatchObject({
          total: 1,
          automations: [{ id, status: "paused" }],
        });
        expect(
          await (await app.request("/api/automations?scope=attention")).json(),
        ).toMatchObject({ total: 0 });
        expect(
          await (await app.request(`${url}/executions`)).json(),
        ).toMatchObject({
          executions: [{ executionId: "past-failure", status: "failed" }],
        });
        const queue = createConversationWorkQueueTestAdapter();
        const event = {
          namespace: "unavailable",
          identifier: "issue-42",
          eventType: "issue.closed",
          eventKey: "paused-event",
          trustedSummary: "Issue closed",
          occurredAtMs: Date.now(),
          data: { retainedCondition: "one" },
        };
        if (kind === "scheduled") {
          expect(
            await claimDueScheduledRun(getDb(), { nowMs: Date.now() }),
          ).toBeUndefined();
          // Completion of work claimed before pause cannot silently reactivate it.
          await advanceScheduledAutomationAfterRun(getDb(), {
            nowMs: Date.now(),
            status: "completed",
            run: {
              id: "already-started",
              taskId: id,
              status: "running",
              attempt: 1,
              claimedAtMs: Date.now() - 2000,
              scheduledForMs: Date.now() - 1000,
            },
          });
          expect((await read()).status).toBe("paused");
        } else {
          expect(
            await ingestEventAutomations(event, { queue, teamId: "T123" }),
          ).toEqual({ dispatched: 0 });
        }
        expect(
          (await lifecycle("resume", (await read()).revision)).status,
        ).toBe(200);
        const resumed = await read();
        expect(resumed).toMatchObject({
          status: "active",
          credentialMode: initial.credentialMode,
          outcomes: initial.outcomes,
          id,
        });
        if (resumed.kind === "scheduled") {
          expect(resumed.nextRunAtMs).toBeGreaterThan(Date.now());
          expect(
            await claimDueScheduledRun(getDb(), { nowMs: Date.now() }),
          ).toBeUndefined();
          expect(
            await claimDueScheduledRun(getDb(), {
              nowMs: resumed.nextRunAtMs!,
            }),
          ).toMatchObject({ taskId: id });
          const current = (await readScheduledAutomation(getDb(), id))!;
          await saveScheduledAutomation(getDb(), {
            ...current,
            status: "completed",
            nextRunAtMs: undefined,
          });
          expect(
            (await lifecycle("resume", (await read()).revision)).status,
          ).toBe(400);
        } else {
          expect(
            await ingestEventAutomations(
              { ...event, eventKey: "new-event" },
              { queue, teamId: "T123" },
            ),
          ).toEqual({ dispatched: 1 });
        }
      } finally {
        await fixture.close();
      }
    },
  );

  /* oxlint-enable vitest/no-conditional-expect */

  test("keeps blocked requirements through pause and refuses to replay a missed one-off", async () => {
    const { app, fixture, id, url, read } = await setup("scheduled");
    try {
      const lifecycle = async (action: string) =>
        app.request(`${url}/lifecycle`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, revision: (await read()).revision }),
        });
      expect((await lifecycle("pause")).status).toBe(200);
      expect((await lifecycle("resume")).status).toBe(200);
      expect(await readScheduledAutomation(getDb(), id)).toMatchObject({
        status: "blocked",
        statusReason: "Missing credentials",
      });
      expect((await lifecycle("resume")).status).toBe(200);
      const task = (await readScheduledAutomation(getDb(), id))!;
      await saveScheduledAutomation(getDb(), {
        ...task,
        status: "paused",
        nextRunAtMs: Date.now() - 1000,
        schedule: {
          kind: "one_off",
          description: "Yesterday",
          timezone: "UTC",
        },
      });
      const result = await lifecycle("resume");
      expect(result.status).toBe(400);
      expect(await result.json()).toMatchObject({
        fields: { schedule: expect.any(Array) },
      });
      expect((await read()).status).toBe("paused");
    } finally {
      await fixture.close();
    }
  });

  test("previews schedules without saving and exposes only durable Event choices", async () => {
    const { app, fixture, url, read } = await setup("scheduled");
    try {
      const initial = await read();
      const preview = (timezone: string, viewer = "creator@example.com") =>
        app.request(`${url}/preview`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "test-viewer": viewer,
          },
          body: JSON.stringify({
            kind: "recurring",
            frequency: "weekly",
            weekdays: ["monday"],
            time: "09:00",
            timezone,
          }),
        });
      const result = await preview("Europe/Vienna");
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({
        nextRunAtMs: expect.any(Number),
        schedule: {
          timezone: "Europe/Vienna",
          recurrence: { weekdays: [1], time: { hour: 9, minute: 0 } },
        },
      });
      expect(
        (await preview("Europe/Vienna", "reader@example.com")).status,
      ).toBe(404);
      expect((await preview("Not/AZone")).status).toBe(400);
      expect(await read()).toEqual(initial);
      vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
      setPlugins([githubPlugin()]);
      const catalog = await app.request("/api/automations/event-catalog");
      expect(catalog.status).toBe(200);
      const choices = await catalog.json();
      expect(choices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            namespace: "github",
            type: "issue",
            supportedEvents: expect.arrayContaining(["issue.closed"]),
          }),
        ]),
      );
      expect(
        choices.some(
          (choice: { namespace: string }) => choice.namespace === "junior",
        ),
      ).toBe(false);
      const summary = await app.request(`/api/automations/${initial.id}`, {
        headers: { "test-viewer": "reader@example.com" },
      });
      expect(await summary.json()).toMatchObject({
        credentialMode: "creator",
        ownedByViewer: false,
      });
    } finally {
      await fixture.close();
    }
  });

  test.each(["scheduled", "event"] as const)(
    "edits %s Automations without losing fields, titles, authority, or history",
    async (kind) => {
      const { app, fixture, id, url, read, patch, user } = await setup(kind);
      try {
        const initial = await read();
        await recordAutomationExecution(kind, id, {
          executionId: "retained-run",
          nowMs: Date.now(),
          status: "completed",
        });
        const edited = await patch({
          kind,
          revision: initial.revision,
          instruction: "Post the revised digest.",
        });
        expect(edited.status).toBe(200);
        const saved = automationEditSchema.parse(await edited.json());
        expect(saved).toMatchObject({
          ...initial,
          revision: expect.any(String),
          instruction: "Post the revised digest.",
        });
        expect(saved.revision).not.toBe(initial.revision);

        // Slack and web use the same edit rules; neither regenerates a saved title.
        if (kind === "scheduled") {
          await execute(
            createSlackScheduleUpdateAutomationTool({
              actor: { platform: "slack", teamId: "T123", userId: "U123" },
              source: createSlackSource({
                ...destination,
                visibility: "public",
              }),
              conversationId: "slack:T123:U123:edit",
              users: {
                resolveActor: async () => ({
                  user,
                  identity: user.identities[0]!,
                }),
              },
            }),
            {
              automationId: id,
              instruction: "Edited from Slack.",
              title: "Title from Slack",
            },
          );
          await execute(
            createSlackScheduleUpdateAutomationTool({
              actor: { platform: "slack", teamId: "T123", userId: "U123" },
              source: createSlackSource({
                ...destination,
                visibility: "public",
              }),
              conversationId: "slack:T123:U123:edit",
              users: {
                resolveActor: async () => ({
                  user,
                  identity: user.identities[0]!,
                }),
              },
            }),
            { automationId: id, instruction: "Edited again from Slack." },
          );
        } else {
          await execute(
            createUpdateEventAutomationTool(
              {
                ...eventContext("U123", "C123", "public", undefined, "T123"),
                conversationId: "slack:T123:U123:edit",
              },
              getEventCatalog(),
            ),
            {
              automationId: id,
              instruction: "Edited from Slack.",
              title: "Title from Slack",
            },
          );
          await execute(
            createUpdateEventAutomationTool(
              {
                ...eventContext("U123", "C123", "public", undefined, "T123"),
                conversationId: "slack:T123:U123:edit",
              },
              getEventCatalog(),
            ),
            { automationId: id, instruction: "Edited again from Slack." },
          );
        }
        const stale = await patch({
          kind,
          revision: saved.revision,
          title: "Stale save",
          credentialMode: "system",
          outcomes: [],
        });
        expect(stale.status).toBe(409);
        expect(await stale.json()).toMatchObject({ code: "conflict" });
        const fromSlack = await read();
        expect(fromSlack).toMatchObject({
          title: "Title from Slack",
          instruction: "Edited again from Slack.",
          credentialMode: "creator",
          outcomes: initial.outcomes,
        });

        // One save wins; the other must fail even when both read the same revision.
        const responses = await Promise.all(
          ["First", "Second"].map((title) =>
            patch({ kind, revision: fromSlack.revision, title }),
          ),
        );
        expect(responses.map((response) => response.status).sort()).toEqual([
          200, 409,
        ]);
        const current = await read();
        const retainedOutcomes = await patch({
          kind,
          revision: current.revision,
          outcomes: [
            ...current.outcomes,
            { action: "send_message", destination: "current_conversation" },
            { action: "send_message", destination: "task_creator" },
          ],
          credentialMode: "system",
        });
        expect(retainedOutcomes.status).toBe(200);
        const outcomes = automationEditSchema.parse(
          await retainedOutcomes.json(),
        );
        expect(outcomes.outcomes).toEqual([
          initial.outcomes[0],
          { action: "send_message", destination },
          {
            action: "send_message",
            destination: { ...destination, channelId: expect.any(String) },
          },
        ]);
        expect(
          getCapturedSlackApiCalls("conversations.open").at(-1)?.params,
        ).toMatchObject({ users: "U123" });
        expect(outcomes.credentialMode).toBe("system");
        const executions = await app.request(`${url}/executions`);
        expect(await executions.json()).toMatchObject({
          executions: [{ executionId: "retained-run", status: "completed" }],
        });
        const stored =
          kind === "scheduled"
            ? await readScheduledAutomation(getDb(), id)
            : await getEventAutomation(getDb(), id);
        expect(stored).toMatchObject(
          initial.kind === "scheduled"
            ? {
                status: "blocked",
                statusReason: "Missing credentials",
                nextRunAtMs: initial.nextRunAtMs,
              }
            : { trigger: initial.trigger },
        );
      } finally {
        await fixture.close();
      }
    },
  );

  test.each(["scheduled", "event"] as const)(
    "rejects unauthorized and invalid %s edits without partial changes",
    async (kind) => {
      const { app, fixture, url, read, patch } = await setup(kind);
      try {
        const initial = await read();
        const input = {
          kind,
          revision: initial.revision,
          title: "Must not save",
          credentialMode: "system",
        };
        for (const viewer of ["reader@example.com", "foreign@example.com"]) {
          expect(
            (
              await app.request(`${url}/edit`, {
                headers: { "test-viewer": viewer },
              })
            ).status,
          ).toBe(404);
          expect((await patch(input, viewer)).status).toBe(404);
        }
        expect(
          (
            await createJuniorApi().request(url, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(input),
            })
          ).status,
        ).toBe(401);
        const invalid = await patch({ ...input, instruction: " " });
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({
          code: "invalid_edit",
          fields: { instruction: expect.any(Array) },
        });
        const newDestination = await patch({
          ...input,
          outcomes: [
            {
              action: "send_message",
              destination: { ...destination, channelId: "CPRIVATE" },
            },
          ],
        });
        expect(newDestination.status).toBe(400);
        expect(await newDestination.json()).toMatchObject({
          fields: { outcomes: expect.any(Array) },
        });
        const badTrigger = await patch({
          ...input,
          ...(kind === "scheduled"
            ? {
                schedule: {
                  kind: "recurring",
                  frequency: "daily",
                  time: "09:00",
                  timezone: "Not/AZone",
                },
              }
            : {
                trigger: {
                  namespace: "junior",
                  resourceType: "timer",
                  identifier: "test",
                  label: "Invalid",
                  events: ["timer.fired"],
                },
              }),
        });
        expect(badTrigger.status).toBe(400);
        expect(await badTrigger.json()).toMatchObject({
          fields: {
            [kind === "scheduled" ? "schedule" : "trigger"]: expect.any(Array),
          },
        });
        expect(await read()).toEqual(initial);
      } finally {
        await fixture.close();
      }
    },
  );

  test("compiles schedules without resuming blocked or completed work", async () => {
    const { fixture, id, read, patch } = await setup("scheduled");
    try {
      const initial = await read();
      const response = await patch({
        kind: "scheduled",
        revision: initial.revision,
        schedule: {
          kind: "recurring",
          frequency: "weekly",
          weekdays: ["monday"],
          time: "10:30",
          timezone: "America/Los_Angeles",
        },
      });
      expect(response.status).toBe(200);
      const saved = automationEditSchema.parse(await response.json());
      expect(saved).toMatchObject({
        status: "blocked",
        schedule: {
          timezone: "America/Los_Angeles",
          recurrence: {
            frequency: "weekly",
            weekdays: [1],
            time: { hour: 10, minute: 30 },
          },
        },
      });
      const task = await readScheduledAutomation(getDb(), id);
      if (!task) throw new Error("Missing scheduled Automation");
      await saveScheduledAutomation(getDb(), {
        ...task,
        status: "completed",
        nextRunAtMs: undefined,
        schedule: {
          kind: "one_off",
          timezone: "UTC",
          description: "Completed reminder",
        },
      });
      const completed = await read();
      expect(
        (
          await patch({
            kind: "scheduled",
            revision: completed.revision,
            schedule: {
              kind: "one_off",
              timing: { type: "after", value: 1, unit: "hour" },
            },
          })
        ).status,
      ).toBe(400);
      expect(await read()).toEqual(completed);
    } finally {
      await fixture.close();
    }
  });

  test("validates replacement event selectors through the registered plugin", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
    setPlugins([githubPlugin()]);
    const { fixture, read, patch } = await setup("event");
    try {
      const initial = await read();
      if (initial.kind !== "event")
        throw new Error("Expected event Automation");
      const retained = await patch({
        kind: "event",
        revision: initial.revision,
        trigger: initial.trigger,
        title: "Retained selector",
      });
      expect(retained.status).toBe(200);
      const current = await read();
      const trigger = {
        namespace: "github",
        resourceType: "pull_request",
        identifier: "GETSENTRY/JUNIOR#42",
        label: "PR 42",
        events: ["pull_request.merged"],
        match: { headBranch: "main" },
      };
      const invalid = await patch({
        kind: "event",
        revision: current.revision,
        trigger: { ...trigger, match: { unknownField: "not allowed" } },
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({
        fields: { trigger: expect.any(Array) },
      });
      const response = await patch({
        kind: "event",
        revision: current.revision,
        trigger,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        trigger: { ...trigger, identifier: "getsentry/junior#42" },
        triggerAvailable: true,
      });
    } finally {
      await fixture.close();
    }
  });
});
