/**
 * Agent-facing sandbox adaptation.
 *
 * The sandbox module owns provider lifecycle and recovery. This module adds
 * agent-specific preparation, durable reference propagation, custom command
 * routing, and generated-artifact materialization.
 */
import type { FileUpload } from "chat";
import { isUserActor, type Actor } from "@/chat/actor";
import { maybeExecuteJrRpcCustomCommand } from "@/chat/capabilities/jr-rpc-command";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
import type { CredentialContext } from "@/chat/credentials/context";
import { listReferenceFiles } from "@/chat/discovery";
import type { LogContext } from "@/chat/logging";
import { formatSandboxCommandResult } from "@/chat/sandbox/command-result";
import type { SandboxEgressTracePropagationConfig } from "@/chat/sandbox/egress/tracing";
import type { SandboxEgressSignalTransport } from "@/chat/sandbox/egress/signals";
import type { SandboxRef } from "@/chat/sandbox/ref";
import { createSandbox, type SandboxTools } from "@/chat/sandbox/sandbox";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import type { Skill, SkillMetadata } from "@/chat/skills";
import { writeSandboxGeneratedArtifacts } from "@/chat/tools/sandbox/generated-artifacts";
import type { GeneratedArtifactFileRef } from "@/chat/tools/sandbox/file-uploads";

export interface AgentSandboxOptions {
  sandboxRef?: SandboxRef;
  skills: SkillMetadata[];
  traceContext: LogContext;
  tracePropagation?: SandboxEgressTracePropagationConfig;
  egressSignals?: SandboxEgressSignalTransport;
  credentialEgress?: CredentialContext;
  actor?: Actor;
  channelConfiguration?: ChannelConfigurationService;
  configurationValues: Record<string, unknown>;
  getActiveSkill(): Skill | null;
  prepareSandbox(workspace: SandboxWorkspace): void | Promise<void>;
  onSandboxRefChanged(sandboxRef: SandboxRef): void;
  persistSandboxRef?(sandboxRef: SandboxRef): void | Promise<void>;
}

export interface AgentSandbox {
  readonly tools: SandboxTools;
  readonly workspace: SandboxWorkspace;
  sandboxRef(): SandboxRef | undefined;
  close(): void;
  writeGeneratedArtifacts(
    files: FileUpload[],
  ): Promise<GeneratedArtifactFileRef[]>;
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
            channelConfiguration: options.channelConfiguration,
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
