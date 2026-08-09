/**
 * Agent-facing sandbox adaptation.
 *
 * The sandbox module owns provider lifecycle and recovery. This module adds
 * agent-specific preparation, durable reference propagation, custom command
 * routing, and generated-artifact materialization.
 */
import type { FileUpload } from "chat";
import type { PluginSandbox } from "@sentry/junior-plugin-api";
import { isUserActor, type Actor } from "@/chat/actor";
import { maybeExecuteJrRpcCustomCommand } from "@/chat/capabilities/jr-rpc-command";
import type { DestinationConfigurationService } from "@/chat/configuration/types";
import type { CredentialContext } from "@/chat/credentials/context";
import { listReferenceFiles } from "@/chat/discovery";
import type { LogContext } from "@/chat/logging";
import { formatSandboxCommandResult } from "@/chat/sandbox/command-result";
import { buildCommandScript } from "@/chat/sandbox/noninteractive-command";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import type { SandboxEgressTracePropagationConfig } from "@/chat/sandbox/egress/tracing";
import type { SandboxEgressSignalTransport } from "@/chat/sandbox/egress/signals";
import type { SandboxRef } from "@/chat/sandbox/ref";
import type { RepositoryInstructions } from "@/chat/repository-instructions";
import { createSandbox, type SandboxTools } from "@/chat/sandbox/sandbox";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import type { Skill, SkillMetadata } from "@/chat/skills";
import { writeSandboxGeneratedArtifacts } from "@/chat/tools/sandbox/generated-artifacts";
import type { GeneratedArtifactFileRef } from "@/chat/tools/sandbox/file-uploads";
import { normalizeToolResult } from "@/chat/tool-support/normalize-result";

export interface AgentSandboxOptions {
  sandboxRef?: SandboxRef;
  skills: SkillMetadata[];
  traceContext: LogContext;
  tracePropagation?: SandboxEgressTracePropagationConfig;
  egressSignals?: SandboxEgressSignalTransport;
  credentialEgress?: CredentialContext;
  actor?: Actor;
  destinationConfiguration?: DestinationConfigurationService;
  configurationValues: Record<string, unknown>;
  getActiveSkill(): Skill | null;
  prepareSandbox(workspace: SandboxWorkspace): void | Promise<void>;
  onSandboxRefChanged(sandboxRef: SandboxRef): void;
  persistSandboxRef?(sandboxRef: SandboxRef): void | Promise<void>;
}

export interface AgentSandbox {
  /** Resolve the AGENTS.md bundle for the selected repository directory. */
  captureRepositoryInstructions(): Promise<RepositoryInstructions | undefined>;
  readonly tools: SandboxTools;
  readonly workspace: SandboxWorkspace;
  sandboxRef(): SandboxRef | undefined;
  close(): void;
  writeGeneratedArtifacts(
    files: FileUpload[],
  ): Promise<GeneratedArtifactFileRef[]>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textContent(value: unknown): string {
  return Array.isArray(value)
    ? value
        .flatMap((part) => {
          const item = record(part);
          return item.type === "text" && typeof item.text === "string"
            ? [item.text]
            : [];
        })
        .join("\n")
    : "";
}

/** Adapt agent sandbox execution for plugin-owned workspace tools. */
export function createPluginToolSandbox(
  sandbox: Pick<AgentSandbox, "tools" | "workspace">,
  options: { handleAuthSignal(details: unknown): Promise<void> },
): PluginSandbox {
  return {
    root: SANDBOX_WORKSPACE_ROOT,
    juniorRoot: `${SANDBOX_WORKSPACE_ROOT}/.junior`,
    async readFile(filePath) {
      return (
        (await sandbox.workspace.readFileToBuffer({ path: filePath })) ?? null
      );
    },
    async run(input) {
      input.signal?.throwIfAborted();
      const result = await sandbox.tools.execute({
        toolName: "bash",
        input: {
          command: `${input.sudo ? "sudo -- " : ""}${buildCommandScript(input)}`,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.env ? { env: input.env } : {}),
        },
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const normalized = normalizeToolResult(result, { toolName: "bash" });
      await options.handleAuthSignal(normalized.details);
      input.signal?.throwIfAborted();
      const details = record(normalized.details);
      return {
        exitCode: typeof details.exit_code === "number" ? details.exit_code : 1,
        stdout: typeof details.stdout === "string" ? details.stdout : "",
        stderr:
          details.permission_denied !== undefined
            ? textContent(normalized.content)
            : typeof details.stderr === "string"
              ? details.stderr
              : "",
      };
    },
    async writeFile(input) {
      await sandbox.workspace.writeFiles([
        {
          path: input.path,
          content: input.content,
          ...(input.mode !== undefined ? { mode: input.mode } : {}),
        },
      ]);
    },
  };
}

function bashCommand(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" && command.trim()
    ? command.trim()
    : undefined;
}

/** Create run-scoped sandbox capabilities adapted to the current agent context. */
export function createAgentSandbox(options: AgentSandboxOptions): AgentSandbox {
  const sandbox = createSandbox({
    sandboxRef: options.sandboxRef,
    skills: options.skills,
    referenceFiles: listReferenceFiles(),
    traceContext: options.traceContext,
    tracePropagation: options.tracePropagation,
    egressSignals: options.egressSignals,
    credentialEgress: options.credentialEgress,
    prepare: options.prepareSandbox,
    onSandboxRefChanged: async (sandboxRef) => {
      options.onSandboxRefChanged(sandboxRef);
      await options.persistSandboxRef?.(sandboxRef);
    },
  });

  return {
    captureRepositoryInstructions: sandbox.captureRepositoryInstructions,
    workspace: sandbox.workspace,
    sandboxRef: sandbox.sandboxRef,
    close: sandbox.close,
    tools: {
      supports: sandbox.tools.supports,
      async execute(params) {
        const command =
          params.toolName === "bash" ? bashCommand(params.input) : undefined;
        if (command) {
          const result = await maybeExecuteJrRpcCustomCommand(command, {
            activeSkill: options.getActiveSkill(),
            destinationConfiguration: options.destinationConfiguration,
            actorId: isUserActor(options.actor)
              ? options.actor.userId
              : undefined,
            onConfigurationValueChanged: (key, value) => {
              if (value === undefined) {
                delete options.configurationValues[key];
                return;
              }
              options.configurationValues[key] = value;
            },
          });
          if (result.handled) {
            return formatSandboxCommandResult(result.result);
          }
        }
        return await sandbox.tools.execute(params);
      },
    },
    async writeGeneratedArtifacts(files) {
      return await writeSandboxGeneratedArtifacts(sandbox.workspace, files);
    },
  };
}
