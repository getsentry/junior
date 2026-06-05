import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import type { TurnThinkingSelection } from "@/chat/services/turn-thinking-level";
import {
  configureRespondRuntimeEnv,
  restoreRespondRuntimeEnv,
} from "../../fixtures/respond-env";
import {
  createScriptedReplyAgentFactory,
  type ScriptedReplyAgent,
} from "../../fixtures/respond-agent";
import {
  createScriptedSandboxExecutorFactory,
  createScriptedSandboxExecutorState,
  type ScriptedSandboxExecutorState,
} from "../../fixtures/respond-sandbox";

const originalEnv = configureRespondRuntimeEnv();

const { generateAssistantReply } = await import("@/chat/respond");
const { disconnectStateAdapter } = await import("@/chat/state/adapter");
const { resetSkillDiscoveryCache } = await import("@/chat/skills");

type AgentMode =
  | "plain"
  | "loadSkill"
  | "attachFile"
  | "attachFileThenError"
  | "bashThenError";

const agentMode: { value: AgentMode } = {
  value: "plain",
};
const selectedThinkingLevels: unknown[] = [];
let sandboxState: ScriptedSandboxExecutorState;
let skillRoot: string | undefined;

const baseAgentFactory = createScriptedReplyAgentFactory({
  async continue() {
    return {};
  },
  async prompt(agent, message) {
    agent.state.messages.push(message as PiMessage);

    if (agentMode.value === "loadSkill") {
      await executeAgentTool(agent, "loadSkill", {
        skill_name: "demo-skill",
      });
      agent.state.messages.push(assistantText("Loaded demo skill."));
      return {};
    }

    if (
      agentMode.value === "attachFile" ||
      agentMode.value === "attachFileThenError"
    ) {
      await executeAgentTool(agent, "attachFile", {
        path: "report.txt",
      });
      if (agentMode.value === "attachFileThenError") {
        throw new Error("agent exploded");
      }
      agent.state.messages.push(assistantText("Attached report."));
      return {};
    }

    if (agentMode.value === "bashThenError") {
      await executeAgentTool(agent, "bash", {
        command: "pwd",
      });
      throw new Error("agent exploded");
    }

    agent.state.messages.push(assistantText("Plain reply."));
    return {};
  },
});

const agentFactory: typeof baseAgentFactory = (options) => {
  selectedThinkingLevels.push(options.initialState.thinkingLevel);
  return baseAgentFactory(options);
};

function assistantText(text: string): PiMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
  } as PiMessage;
}

async function executeAgentTool(
  agent: ScriptedReplyAgent,
  name: string,
  params: Record<string, unknown>,
): Promise<void> {
  const tool = agent.state.tools.find(
    (
      candidate,
    ): candidate is {
      execute: (toolCallId: unknown, params: unknown) => Promise<unknown>;
      name: string;
    } =>
      typeof candidate === "object" &&
      candidate !== null &&
      "name" in candidate &&
      candidate.name === name &&
      "execute" in candidate &&
      typeof candidate.execute === "function",
  );
  if (!tool) {
    throw new Error(`${name} tool missing`);
  }
  await tool.execute(`tool-call-${name}`, params);
}

function thinkingSelection(
  thinkingLevel: TurnThinkingSelection["thinkingLevel"],
): TurnThinkingSelection {
  return {
    thinkingLevel,
    confidence: 1,
    reason: "test",
  };
}

async function writeDemoSkill(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "junior-skills-"));
  const skillDir = path.join(root, "demo-skill");
  await fs.mkdir(skillDir);
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: demo-skill",
      "description: Demo skill",
      "---",
      "",
      "Skill instructions",
      "",
    ].join("\n"),
    "utf8",
  );
  return root;
}

function sandboxExecutorFactory() {
  return createScriptedSandboxExecutorFactory(sandboxState, {
    canExecute: (toolName) =>
      agentMode.value === "bashThenError" && toolName === "bash",
  });
}

async function generateReply(
  message: string,
  options: Parameters<typeof generateAssistantReply>[1] = {},
) {
  return await generateAssistantReply(message, {
    agentFactory,
    destination: {
      platform: "local",
      conversationId: "local:test:lazy_sandbox",
    },
    requester: {
      platform: "local",
      userId: "test-user",
      userName: "Test User",
    },
    sandboxExecutorFactory: sandboxExecutorFactory(),
    skillDirs: skillRoot ? [skillRoot] : [],
    turnThinkingSelection: thinkingSelection("medium"),
    ...options,
  });
}

describe("generateAssistantReply lazy sandbox boot", () => {
  beforeEach(async () => {
    agentMode.value = "plain";
    selectedThinkingLevels.length = 0;
    sandboxState = createScriptedSandboxExecutorState();
    skillRoot = await writeDemoSkill();
    resetSkillDiscoveryCache();
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    resetSkillDiscoveryCache();
    if (skillRoot) {
      await fs.rm(skillRoot, { recursive: true, force: true });
      skillRoot = undefined;
    }
  });

  afterAll(() => {
    restoreRespondRuntimeEnv(originalEnv);
  });

  it("does not create a sandbox for turns that never touch sandbox-backed tools", async () => {
    const reply = await generateReply("hello", {
      turnThinkingSelection: thinkingSelection("none"),
    });

    expect(reply.text).toBe("Plain reply.");
    expect(sandboxState.createSandboxCalls).toBe(0);
    expect(reply.sandboxId).toBeUndefined();
    expect(reply.sandboxDependencyProfileHash).toBeUndefined();
    expect(reply.diagnostics.toolCalls).toEqual([]);
    expect(selectedThinkingLevels).toEqual(["off"]);
  });

  it("does not create a sandbox when loadSkill only reads host-side skill data", async () => {
    agentMode.value = "loadSkill";

    const reply = await generateReply("load the demo skill");

    expect(reply.text).toBe("Loaded demo skill.");
    expect(sandboxState.createSandboxCalls).toBe(0);
    expect(reply.sandboxId).toBeUndefined();
    expect(reply.diagnostics.toolCalls).toEqual(["loadSkill"]);
    expect(selectedThinkingLevels).toEqual(["medium"]);
  });

  it("does not create a sandbox for restored skill history at turn start", async () => {
    const reply = await generateReply("hello", {
      piMessages: [
        {
          role: "toolResult",
          toolName: "loadSkill",
          isError: false,
          details: {
            skill_name: "demo-skill",
          },
          content: [{ type: "text", text: "loaded" }],
        } as PiMessage,
      ],
    });

    expect(reply.text).toBe("Plain reply.");
    expect(sandboxState.createSandboxCalls).toBe(0);
    expect(reply.diagnostics.toolCalls).toEqual([]);
  });

  it("memoizes the lazy sandbox workspace across file reads and MIME detection", async () => {
    agentMode.value = "attachFile";

    const reply = await generateReply("attach the report");

    expect(reply.text).toBe("Attached report.");
    expect(sandboxState.createSandboxCalls).toBe(1);
    expect(reply.diagnostics.toolCalls).toEqual(["attachFile"]);
    expect(selectedThinkingLevels).toEqual(["medium"]);
  });

  it("retains sandbox reuse metadata after lazy boot on error turns", async () => {
    agentMode.value = "attachFileThenError";

    const reply = await generateReply("attach the report");

    expect(reply.text).toContain("Error: agent exploded");
    expect(sandboxState.createSandboxCalls).toBe(1);
    expect(reply.sandboxId).toBe("sandbox-test");
    expect(reply.sandboxDependencyProfileHash).toBe("hash-test");
  });

  it("reports sandbox metadata as soon as lazy boot succeeds on error turns", async () => {
    agentMode.value = "attachFileThenError";
    const onSandboxAcquired = vi.fn();

    const reply = await generateReply("attach the report", {
      onSandboxAcquired,
    });

    expect(reply.text).toContain("Error: agent exploded");
    expect(onSandboxAcquired).toHaveBeenCalledTimes(1);
    expect(onSandboxAcquired).toHaveBeenCalledWith({
      sandboxId: "sandbox-test",
      sandboxDependencyProfileHash: "hash-test",
    });
  });

  it("retains sandbox reuse metadata after executor-backed boot on error turns", async () => {
    agentMode.value = "bashThenError";

    const reply = await generateReply("run pwd");

    expect(reply.text).toContain("Error: agent exploded");
    expect(sandboxState.createSandboxCalls).toBe(1);
    expect(sandboxState.executedTools).toEqual(["bash"]);
    expect(reply.sandboxId).toBe("sandbox-test");
    expect(reply.sandboxDependencyProfileHash).toBe("hash-test");
  });
});
