import {
  claimDueScheduledRun,
  advanceScheduledAutomationAfterRun,
  markScheduledRunFailed,
} from "@/chat/scheduled-automations/runs";
import { describe, expect, test } from "vitest";
import { getDb } from "@/chat/db";
import {
  readScheduledAutomation,
  saveScheduledAutomation,
} from "@/chat/scheduled-automations/tasks";
import { recordAutomationExecution } from "@/chat/automations/execution-stats";
import { getReviewItem, insertReviewItem } from "@/chat/review-items/store";
import { setupAutomationEditApi as setup } from "../../fixtures/automation-edit-api";

describe("Automation lifecycle API", () => {
  test.each(["scheduled", "event"] as const)(
    "lets public readers pause and delete %s work without using creator credentials",
    async (kind) => {
      const { app, fixture, id, url, read, patch, lifecycle } =
        await setup(kind);
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
        await recordAutomationExecution(id, {
          executionId: "past-failure",
          status: "failed",
          nowMs: Date.now() - 5000,
        });
        const initial = await read();
        expect(
          (await lifecycle("pause", initial.revision, "foreign@example.com"))
            .status,
        ).toBe(404);
        // Anyone who can read a public Automation can pause it.
        expect(
          (await lifecycle("pause", initial.revision, "reader@example.com"))
            .status,
        ).toBe(200);
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
        // Only the creator can restart work that uses their credentials.
        const readerResume = await lifecycle(
          "resume",
          paused.revision,
          "reader@example.com",
        );
        expect(readerResume.status).toBe(400);
        expect(await readerResume.json()).toMatchObject({
          fields: { credentialMode: expect.any(Array) },
        });
        expect((await lifecycle("resume", paused.revision)).status).toBe(200);
        const resumed = await read();
        expect(resumed).toMatchObject({
          status: "active",
          credentialMode: initial.credentialMode,
          outcomes: initial.outcomes,
          id,
        });
        // Lifecycle changes are not definition changes.
        expect(
          await (await app.request(`${url}/versions`)).json(),
        ).toMatchObject({ versions: [{ version: 1 }] });
        // A run of the Automation asked a person something.
        const item = await insertReviewItem(getDb(), {
          addedByConversationId: "slack:T123:U123:edit",
          assignedToEveryone: false,
          assigneeUserIds: [],
          automationId: id,
          body: "The digest is empty this week.",
          conversationIds: [],
          dedupeKey: "digest:empty",
          kind: "action",
          nowMs: Date.now(),
          request: {
            question: "Post an empty digest?",
            fields: [{ id: "note", kind: "text", label: "Note" }],
          },
          title: "Post an empty digest?",
          visibility: "public",
        });
        // A public reader can also delete it.
        expect(
          (
            await app.request(url, {
              method: "DELETE",
              headers: { "test-viewer": "reader@example.com" },
            })
          ).status,
        ).toBe(204);
        expect((await app.request(`${url}/edit`)).status).toBe(404);
        // No run can act on the question now, so it closes. The row stays.
        expect(await getReviewItem(getDb(), item!.id)).toMatchObject({
          closeReason: "Automation deleted",
          status: "dismissed",
        });
      } finally {
        await fixture.close();
      }
    },
  );

  test("resumes future schedule times without restarting completed work", async () => {
    const { fixture, id, read, lifecycle } = await setup("scheduled");
    try {
      const task = (await readScheduledAutomation(getDb(), id))!;
      await saveScheduledAutomation(getDb(), {
        ...task,
        status: "active",
        statusReason: undefined,
        nextRunAtMs: Date.now() - 1000,
      });
      // Use a real claim to cover work that started before pause.
      const run = (await claimDueScheduledRun(getDb(), { nowMs: Date.now() }))!;
      expect(run).toMatchObject({ taskId: id });
      expect((await lifecycle("pause")).status).toBe(200);
      expect(
        await claimDueScheduledRun(getDb(), { nowMs: Date.now() }),
      ).toBeUndefined();
      await markScheduledRunFailed(getDb(), {
        runId: run.id,
        completedAtMs: Date.now(),
        errorMessage: "Run failed after pause",
      });
      await advanceScheduledAutomationAfterRun(getDb(), {
        nowMs: Date.now(),
        status: "failed",
        run,
      });
      expect((await read()).status).toBe("paused");
      expect((await lifecycle("resume")).status).toBe(200);
      const resumed = (await readScheduledAutomation(getDb(), id))!;
      expect(resumed.nextRunAtMs).toBeGreaterThan(Date.now());
      expect(
        await claimDueScheduledRun(getDb(), { nowMs: Date.now() }),
      ).toBeUndefined();
      expect(
        await claimDueScheduledRun(getDb(), { nowMs: resumed.nextRunAtMs! }),
      ).toMatchObject({ taskId: id });
      await saveScheduledAutomation(getDb(), {
        ...resumed,
        status: "completed",
        nextRunAtMs: undefined,
      });
      expect((await lifecycle("resume")).status).toBe(400);
    } finally {
      await fixture.close();
    }
  });

  test("keeps blocked requirements through pause and refuses to replay a missed one-off", async () => {
    const { fixture, id, read, lifecycle } = await setup("scheduled");
    try {
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
});
