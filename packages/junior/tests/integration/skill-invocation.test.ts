import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { executeAgentRun } from "@/chat/agent";
import { runLocalAgentTurn, type LocalToolResult } from "@/chat/local/runner";
import { createAgentRunner } from "@/chat/runtime/agent-runner";
import { createModelStream } from "../fixtures/model-stream";

it("hides user-callable skills and rejects loading them without explicit invocation", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "junior-skill-invocation-"),
  );
  const skillName = "release-checklist";
  const instructions = "Check the release owner and rollback plan.";
  await fs.mkdir(path.join(root, skillName));
  await fs.writeFile(
    path.join(root, skillName, "SKILL.md"),
    [
      "---",
      `name: ${skillName}`,
      "description: Check a release plan before deployment.",
      "disable-model-invocation: true",
      "---",
      instructions,
    ].join("\n"),
  );

  try {
    // Force a load attempt. The runtime must reject it even if a model guesses
    // the hidden name. Then check explicit invocation in a fresh Conversation.
    const runs: Array<{
      contexts: string[];
      results: LocalToolResult[];
      prompts: string[];
    }> = [];
    for (const explicit of [false, true]) {
      const results: LocalToolResult[] = [];
      const contexts: string[] = [];
      const prompts: string[] = [];
      const model = createModelStream([
        ...(explicit
          ? []
          : [
              {
                type: "toolCall" as const,
                name: "loadSkill",
                arguments: { skill_name: skillName },
              },
            ]),
        { type: "text", text: "Checked." },
      ]);
      const agentRunner = createAgentRunner((run) =>
        executeAgentRun(
          { ...run, environment: { ...run.environment, skillDirs: [root] } },
          (modelId, context, options) => {
            prompts.push(context.systemPrompt ?? "");
            contexts.push(JSON.stringify(context.messages));
            return model(modelId, context, options);
          },
        ),
      );
      const outcome = await runLocalAgentTurn(
        {
          conversationId: `local:test:skill-invocation-${explicit}`,
          message: explicit
            ? `$${skillName} check the deployment plan.`
            : "Check the deployment plan.",
        },
        {
          agentRunner,
          deliverReply: async () => {},
          onToolResult: async (result) => {
            results.push(result);
          },
        },
      );
      expect(outcome.outcome).toBe("success");
      runs.push({ contexts, results, prompts });
    }
    expect(runs.flatMap((run) => run.prompts).join("\n")).not.toContain(
      `<name>${skillName}</name>`,
    );
    expect(runs[0].contexts.join("\n")).not.toContain(instructions);
    expect(runs[0].results).toEqual([
      expect.objectContaining({
        toolName: "loadSkill",
        ok: false,
        error: expect.stringContaining(`Unknown skill: ${skillName}`),
      }),
    ]);
    expect(runs[1].contexts[0]).toContain(instructions);
    expect(runs[1].results).toEqual([]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
