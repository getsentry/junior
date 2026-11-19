import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { insertMemory } from "@junior-evals/fixture/insert";
import { readMemories } from "@junior-evals/fixture/memory";
import { test } from "@junior-evals/fixture/test";

/** Store shared knowledge, as an earlier Conversation taught it. */
async function insertKnowledge(content: string) {
  return await insertMemory({
    content,
    kind: "knowledge",
    subjectType: "conversation",
  });
}

async function activeMemoryIds(): Promise<string[]> {
  return (await readMemories()).map((memory) => memory.id);
}

describe("Memory Retirement", () => {
  test("when a person says a remembered behavior changed, retire the old memory", async ({
    run,
  }) => {
    const old = await insertKnowledge(
      "Junior's updatePlan tool does not persist plan steps across Turns.",
    );

    await run(
      slackMention(
        "FYI, updatePlan no longer drops plan steps. The plan is durable now and survives compaction and sandbox resets.",
      ),
    );

    expect(await activeMemoryIds()).not.toContain(old.id);
  });

  test("when a person says a remembered option was renamed, retire the old name", async ({
    run,
  }) => {
    const old = await insertKnowledge(
      "Junior's skipOpenTelemetrySetup option skips OpenTelemetry setup.",
    );

    await run(
      slackMention(
        "Heads up: we renamed skipOpenTelemetrySetup to enableOpenTelemetrySetup in Junior's options. Set enableOpenTelemetrySetup to false to skip OpenTelemetry setup.",
      ),
    );

    const memories = await readMemories();
    expect(memories.map((memory) => memory.id)).not.toContain(old.id);
    expect(memories.map((memory) => memory.content).join("\n")).not.toMatch(
      /skipOpenTelemetrySetup/,
    );
  });

  test("when a person says remembered scope rules changed, retire the old rule", async ({
    run,
  }) => {
    const old = await insertKnowledge(
      "Junior's memory recall probes read personal-scope memories only.",
    );

    await run(
      slackMention(
        "Memory recall is public-only now, so recall probes no longer read personal-scope memories. They read public memories.",
      ),
    );

    expect(await activeMemoryIds()).not.toContain(old.id);
  });

  test("when a person only asks about a remembered fact, keep the memory", async ({
    run,
  }) => {
    const kept = await insertKnowledge(
      "getsentry/junior CI runs package tests with pnpm.",
    );

    await run(
      slackMention(
        "Does getsentry/junior CI still run package tests with pnpm? I'm about to add a new package.",
      ),
    );

    expect(await activeMemoryIds()).toContain(kept.id);
  });

  test("when a person states an exception for another scope, keep the general memory", async ({
    run,
  }) => {
    const kept = await insertKnowledge(
      "Junior's dashboard styles components with Tailwind utility classes.",
    );

    await run(
      slackMention(
        "FYI, Junior's Slack message renderer doesn't use Tailwind at all; it builds mrkdwn strings.",
      ),
    );

    expect(await activeMemoryIds()).toContain(kept.id);
  });
});
