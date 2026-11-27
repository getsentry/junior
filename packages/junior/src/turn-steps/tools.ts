// The tools of each step of a core Turn: the current time, and the file and
// shell tools of the Conversation's sandbox. The sandbox is main's, so it has
// main's network policy and credential egress. The Turn's Actor gives the
// credentials, and the sandbox starts only on the first sandbox call.
import type { JsonValue } from "@earendil-works/pi-ai";
import * as z from "zod";
import { credentialContextForActor } from "@/chat/credentials/context";
import { createAgentSandbox } from "@/chat/agent/sandbox";
import { getDb, getSqlExecutor } from "@/chat/db";
import {
  getPersistedSandboxState,
  getPersistedThreadState,
  persistThreadRuntimeState,
} from "@/chat/runtime/thread-state";
import { buildSandboxInput } from "@/chat/tool-support/build-sandbox-input";
import type { AnyToolDefinition } from "@/chat/tool-support/definition";
import { normalizeToolResult } from "@/chat/tool-support/normalize-result";
import { createBashTool } from "@/chat/tools/sandbox/bash";
import { createEditFileTool } from "@/chat/tools/sandbox/edit-file";
import { createReadFileTool } from "@/chat/tools/sandbox/read-file";
import { createWriteFileTool } from "@/chat/tools/sandbox/write-file";
import { createSystemTimeTool } from "@/chat/tools/system-time";
import { getWorkspace } from "@/chat/workspaces/store";
import type {
  StepTools,
  ToolDefinition,
  ToolExecutionContext,
} from "@/core/tool";
import type { TurnInputRecord } from "@/core/turn/inbox";
import type { ClaimedTurn } from "@/core/turn/state";
import { turnInputPayloadSchema } from "./input-payload";
import { turnToolHooks } from "./tool-hooks";

// The history stores a tool's details as JSON text, which drops undefined
// fields. Main's tools leave optional fields undefined, so the details take
// that same form here.
function storedDetails(details: unknown): JsonValue | undefined {
  return details === undefined
    ? undefined
    : z.json().parse(JSON.parse(JSON.stringify(details)));
}
// Each sandbox tool's own schema parsed the input, so it is an object.
const sandboxInputSchema = z.record(z.string(), z.unknown());

type RunTool = (
  input: unknown,
  context: ToolExecutionContext,
) => Promise<unknown>;

// Adapts one of main's tool definitions to a core tool. A call that may have
// run already runs again only when main marks the tool idempotent.
function coreTool(
  name: string,
  tool: AnyToolDefinition,
  run: RunTool,
): ToolDefinition {
  return {
    name,
    description: tool.description,
    parameters: tool.inputSchema,
    replay: tool.annotations?.idempotentHint ? "safe" : "never",
    async execute(args, context) {
      const input = tool.prepareArguments ? tool.prepareArguments(args) : args;
      const result = normalizeToolResult(await run(input, context), {
        requireStructuredResult: Boolean(tool.outputSchema),
        toolName: name,
      });
      return {
        content: result.content,
        details: storedDetails(result.details),
      };
    },
  };
}

const SANDBOX_TOOLS = {
  bash: createBashTool,
  readFile: createReadFileTool,
  writeFile: createWriteFileTool,
  editFile: createEditFileTool,
};

/**
 * Builds the tools of one step of a core Turn. Every input of a Turn has the
 * same Actor, so the latest input's Actor gives the sandbox its credentials.
 * The sandbox reference is kept where main keeps it, so a later step, and
 * main's engine, reopen the same sandbox.
 */
export async function turnTools(
  turn: ClaimedTurn,
  inputs: TurnInputRecord[],
): Promise<StepTools> {
  const latest = inputs.at(-1);
  if (!latest) {
    throw new Error(`Turn ${turn.turnId} has no inputs`);
  }
  const { actor } = turnInputPayloadSchema.parse(latest.payload);
  const sandboxRef = getPersistedSandboxState(
    await getPersistedThreadState(turn.conversationId),
  );
  const sandbox = createAgentSandbox({
    sandboxRef,
    // A sandbox that must be made again keeps its Workspace, as main's does.
    workspace: sandboxRef?.workspaceId
      ? await getWorkspace(getDb(), sandboxRef.workspaceId)
      : undefined,
    skills: [],
    traceContext: { conversationId: turn.conversationId },
    conversationId: turn.conversationId,
    credentialEgress: credentialContextForActor(actor),
    prepareSandbox: () => {},
    onSandboxRefChanged: () => {},
    persistSandboxRef: (sandboxRef) =>
      persistThreadRuntimeState(turn.conversationId, { sandboxRef }),
  });
  const systemTime = createSystemTimeTool();
  const sandboxTools = Object.entries(SANDBOX_TOOLS).map(
    ([name, create]) => [name, create()] as const,
  );
  return {
    definitions: [
      coreTool("systemTime", systemTime, (input, { callId, signal }) =>
        Promise.resolve(
          systemTime.execute!(input, { signal, toolCallId: callId }),
        ),
      ),
      ...sandboxTools.map(([name, tool]) =>
        coreTool(name, tool, (input, { signal }) =>
          sandbox.tools.execute({
            toolName: name,
            input: buildSandboxInput(name, sandboxInputSchema.parse(input)),
            signal,
          }),
        ),
      ),
    ],
    hooks: turnToolHooks({
      ctx: { executor: getSqlExecutor() },
      turnId: turn.turnId,
      tools: new Map<string, AnyToolDefinition>([
        ["systemTime", systemTime],
        ...sandboxTools,
      ]),
      workspace: sandbox.workspace,
    }),
    close: () => sandbox.close(),
  };
}
