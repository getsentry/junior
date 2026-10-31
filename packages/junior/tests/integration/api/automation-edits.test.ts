import { createSlackSource } from "@sentry/junior-plugin-api";
import { githubPlugin } from "@sentry/junior-github";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createJuniorApi } from "@/api";
import {
  automationEditSchema,
  automationEventCatalogSchema,
  automationListSchema,
  automationVersionListSchema,
} from "@/api/schema/automation";
import { getDb } from "@/chat/db";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import {
  getEventAutomation,
  saveEventAutomation,
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
import {
  destination,
  originalInstruction,
  setupAutomationEditApi as setup,
} from "../../fixtures/automation-edit-api";

describe("Automation edit API", () => {
  afterEach(() => {
    setPlugins([]);
    vi.unstubAllEnvs();
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
      ).toBe(200);
      expect(
        (await preview("Europe/Vienna", "foreign@example.com")).status,
      ).toBe(404);
      expect((await preview("Not/AZone")).status).toBe(400);
      expect(await read()).toEqual(initial);
      vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
      setPlugins([githubPlugin()]);
      const catalog = await app.request("/api/automations/event-catalog");
      expect(catalog.status).toBe(200);
      // The dashboard parses the JSON body with this same schema.
      const choices = automationEventCatalogSchema.parse(await catalog.json());
      // One entry for each namespace, with the reach of each event once.
      const github = choices.find((choice) => choice.namespace === "github");
      expect(github?.events["issue.closed"]).toEqual({
        reach: { anyOf: ["repo"] },
      });
      expect(choices.some((choice) => choice.namespace === "junior")).toBe(
        false,
      );
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
        await recordAutomationExecution(id, {
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
        // Each saved definition change is a version. Rejected saves add none.
        const versionsResponse = await app.request(`${url}/versions`, {
          headers: { "test-viewer": "reader@example.com" },
        });
        expect(versionsResponse.status).toBe(200);
        const { versions } = automationVersionListSchema.parse(
          await versionsResponse.json(),
        );
        expect(
          versions.map(({ version, editedBy, definition }) => [
            version,
            editedBy?.slackUserId,
            definition.instruction,
            definition.title,
            definition.credentialMode,
          ]),
        ).toEqual([
          [6, "U123", "Edited again from Slack.", current.title, "system"],
          [5, "U123", "Edited again from Slack.", current.title, "creator"],
          [
            4,
            "U123",
            "Edited again from Slack.",
            "Title from Slack",
            "creator",
          ],
          [3, "U123", "Edited from Slack.", "Title from Slack", "creator"],
          [2, "U123", "Post the revised digest.", "My custom title", "creator"],
          [1, "U123", originalInstruction, "My custom title", "creator"],
        ]);
        expect(versions[0]!.definition.outcomes).toEqual(outcomes.outcomes);

        // Making an old version active saves it again as the newest version.
        const activate = (version: number, revision: string, viewer?: string) =>
          app.request(`${url}/versions/${version}/activate`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "test-viewer": viewer ?? user.email,
            },
            body: JSON.stringify({ revision }),
          });
        expect((await activate(1, current.revision)).status).toBe(409);
        const restored = await activate(1, outcomes.revision);
        expect(restored.status).toBe(200);
        expect(automationEditSchema.parse(await restored.json())).toMatchObject(
          {
            title: "My custom title",
            instruction: originalInstruction,
            credentialMode: "creator",
            outcomes: initial.outcomes,
          },
        );
        const afterRestore = automationVersionListSchema.parse(
          await (await app.request(`${url}/versions`)).json(),
        );
        expect(afterRestore.activeVersion).toBe(7);
        expect(afterRestore.versions[0]!.definition).toEqual(
          versions.at(-1)!.definition,
        );
        // The creator DM removed by that restore can come back.
        const dmRestore = await activate(6, (await read()).revision);
        expect(dmRestore.status).toBe(200);
        expect(
          automationEditSchema.parse(await dmRestore.json()).outcomes,
        ).toEqual(outcomes.outcomes);

        // A public reader can edit, but cannot use the creator's accounts.
        const readerView = automationEditSchema.parse(
          await (
            await app.request(`${url}/edit`, {
              headers: { "test-viewer": "reader@example.com" },
            })
          ).json(),
        );
        expect(readerView.ownedByViewer).toBe(false);
        const readerEdit = await patch(
          { kind, revision: readerView.revision, instruction: "Reader edit." },
          "reader@example.com",
        );
        expect(readerEdit.status).toBe(200);
        const readerSaved = automationEditSchema.parse(await readerEdit.json());
        expect(readerSaved).toMatchObject({
          instruction: "Reader edit.",
          credentialMode: "system",
          ownedByViewer: false,
        });
        const readerRestore = await activate(
          7,
          readerSaved.revision,
          "reader@example.com",
        );
        expect(readerRestore.status).toBe(400);
        expect(await readerRestore.json()).toMatchObject({
          fields: { credentialMode: expect.any(Array) },
        });
        const afterReader = automationVersionListSchema.parse(
          await (await app.request(`${url}/versions`)).json(),
        );
        expect(
          afterReader.versions
            .slice(0, 2)
            .map(({ version, editedBy }) => [version, editedBy?.slackUserId]),
        ).toEqual([
          [9, "U456"],
          [8, "U123"],
        ]);
        expect(afterReader.activeVersion).toBe(9);
        expect(
          (
            await app.request(`${url}/versions`, {
              headers: { "test-viewer": "foreign@example.com" },
            })
          ).status,
        ).toBe(404);
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
        expect(
          (
            await app.request(`${url}/edit`, {
              headers: { "test-viewer": "foreign@example.com" },
            })
          ).status,
        ).toBe(404);
        expect((await patch(input, "foreign@example.com")).status).toBe(404);
        // Public readers can edit, but creator-only fields stay creator-only.
        for (const [field, value] of [
          ["credentialMode", "creator"],
          ["outcomes", []],
        ] as const) {
          const response = await patch(
            { kind, revision: initial.revision, [field]: value },
            "reader@example.com",
          );
          expect(response.status).toBe(400);
          expect(await response.json()).toMatchObject({
            fields: { [field]: expect.any(Array) },
          });
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
    const { app, fixture, id, url, read, patch } = await setup("scheduled");
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
      // A restored Schedule compiles again and keeps the block.
      const restored = await app.request(`${url}/versions/1/activate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: saved.revision }),
      });
      expect(restored.status).toBe(200);
      expect(automationEditSchema.parse(await restored.json())).toMatchObject({
        status: "blocked",
        schedule: initial.kind === "scheduled" ? initial.schedule : {},
        nextRunAtMs: expect.any(Number),
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
    const { app, fixture, id, read, patch, url } = await setup("event");
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
      // authorUsername is a GitHub filter that was renamed to openerUsername.
      const removed = await patch({
        kind: "event",
        revision: current.revision,
        trigger: { ...trigger, match: { authorUsername: "dcramer" } },
      });
      expect(removed.status).toBe(400);
      expect(await removed.json()).toMatchObject({
        fields: {
          trigger: [
            expect.stringContaining(
              'Filter "authorUsername" (match.authorUsername) does not exist for this resource type.',
            ),
          ],
        },
      });
      // GitHub sends no head branch with pull request comments.
      const neverRuns = await patch({
        kind: "event",
        revision: current.revision,
        trigger: {
          ...trigger,
          events: ["pull_request.merged", "pull_request.comment.created"],
        },
      });
      expect(neverRuns.status).toBe(400);
      expect(await neverRuns.json()).toMatchObject({
        fields: {
          trigger: [
            expect.stringContaining(
              'Filter "headBranch" (match.headBranch) is not set on "pull_request.comment.created"',
            ),
          ],
        },
      });
      const response = await patch({
        kind: "event",
        revision: current.revision,
        trigger,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        trigger: { ...trigger, identifier: "getsentry/junior#42" },
      });
      // Version history shows each saved trigger in the shared words.
      const { versions } = automationVersionListSchema.parse(
        await (await app.request(`${url}/versions`)).json(),
      );
      const saved = {
        events: ["issue closed"],
        filters: ["retainedCondition is one or two"],
        problems: ["The plugin for this source is not enabled."],
      };
      expect(
        versions.map((version) =>
          version.kind === "event" ? version.trigger : undefined,
        ),
      ).toEqual([
        {
          events: ["pull request merged"],
          filters: ["headBranch is main"],
          problems: [],
        },
        saved,
        saved,
      ]);
      const unavailableIds = async () =>
        automationListSchema
          .parse(
            await (
              await app.request("/api/automations?state=unavailable")
            ).json(),
          )
          .automations.map((automation) => automation.id);
      expect(await unavailableIds()).toEqual([]);
      // A saved filter that the plugin renamed never matches, so the
      // Automation reports an unavailable trigger and says why.
      const stored = await getEventAutomation(getDb(), id);
      if (!stored) throw new Error("Missing event Automation");
      await saveEventAutomation(getDb(), {
        ...stored,
        trigger: { ...stored.trigger, match: { authorUsername: "dcramer" } },
      });
      const summary = await app.request(`/api/automations/${id}`);
      expect(summary.status).toBe(200);
      expect(await summary.json()).toMatchObject({
        trigger: {
          filters: ["authorUsername is dcramer"],
          problems: [
            expect.stringContaining('Filter "authorUsername" does not exist'),
          ],
        },
      });
      expect(await unavailableIds()).toEqual([id]);

      // With no identifier, pull request events need a repo filter.
      const anyResource = {
        namespace: "github",
        label: "New pull requests",
        events: ["pull_request.opened"],
      };
      const unscoped = await patch({
        kind: "event",
        revision: (await read()).revision,
        trigger: anyResource,
      });
      expect(unscoped.status).toBe(400);
      expect(await unscoped.json()).toMatchObject({
        fields: {
          trigger: [
            'This GitHub trigger cannot be saved. This trigger needs a "repo" filter (match.repo), because "pull_request.opened" cannot run for every resource.',
          ],
        },
      });
      const scoped = await patch({
        kind: "event",
        revision: (await read()).revision,
        trigger: { ...anyResource, match: { repo: "getsentry/junior" } },
      });
      expect(scoped.status).toBe(200);
      expect(await unavailableIds()).toEqual([]);
      expect(
        await (await app.request(`/api/automations/${id}`)).json(),
      ).toMatchObject({
        resource: "New pull requests",
        trigger: {
          events: ["pull request opened"],
          filters: ["repo is getsentry/junior"],
          problems: [],
        },
      });
    } finally {
      await fixture.close();
    }
  });
});
