import fs from "node:fs";
import path from "node:path";
import { botConfig, getRuntimeMetadata } from "@/chat/config";
import {
  listReferenceFiles,
  soulPathCandidates,
  worldPathCandidates,
} from "@/chat/discovery";
import { logInfo, logWarn } from "@/chat/logging";
import { getPluginProviders } from "@/chat/plugins/registry";
import { slackOutputPolicy } from "@/chat/slack/output";
import { SANDBOX_DATA_ROOT, sandboxSkillDir } from "@/chat/sandbox/paths";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import type { Skill, SkillMetadata, SkillInvocation } from "@/chat/skills";
import type { ExposedToolSummary } from "@/chat/tools/skill/mcp-tool-summary";
import { escapeXml } from "@/chat/xml";

const DEFAULT_SOUL = "You are Junior, a practical and concise assistant.";

function getLoggedMarkdownFiles(): Set<string> {
  const globalState = globalThis as typeof globalThis & {
    __juniorLoggedMarkdownFiles?: Set<string>;
  };
  globalState.__juniorLoggedMarkdownFiles ??= new Set<string>();
  return globalState.__juniorLoggedMarkdownFiles;
}

function loadOptionalMarkdownFile(
  candidates: string[],
  fileName: string,
): string | null {
  for (const resolved of candidates) {
    try {
      const raw = fs.readFileSync(resolved, "utf8").trim();
      if (raw.length > 0) {
        const loggedMarkdownFiles = getLoggedMarkdownFiles();
        const logKey = `${fileName}:${resolved}`;
        if (!loggedMarkdownFiles.has(logKey)) {
          loggedMarkdownFiles.add(logKey);
          logInfo(
            `${fileName.toLowerCase()}_loaded`,
            {},
            {
              "file.path": resolved,
            },
            `Loaded ${fileName}`,
          );
        }
        return raw;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function loadSoul(): string {
  const soul = loadOptionalMarkdownFile(soulPathCandidates(), "SOUL.md");
  if (soul) {
    return soul;
  }

  logWarn(
    "soul_load_fallback",
    {},
    {
      "file.candidates": soulPathCandidates(),
    },
    "SOUL.md not found; using built-in default personality",
  );
  return DEFAULT_SOUL;
}

function loadWorld(): string | null {
  return loadOptionalMarkdownFile(worldPathCandidates(), "WORLD.md");
}

export const JUNIOR_PERSONALITY = (() => {
  try {
    return loadSoul();
  } catch (error) {
    logWarn(
      "soul_load_failed",
      {},
      {
        "error.message": error instanceof Error ? error.message : String(error),
      },
      "Failed to load SOUL.md; using built-in default personality",
    );
    return DEFAULT_SOUL;
  }
})();

export const JUNIOR_WORLD = (() => {
  try {
    return loadWorld();
  } catch (error) {
    logWarn(
      "world_load_failed",
      {},
      {
        "error.message": error instanceof Error ? error.message : String(error),
      },
      "Failed to load WORLD.md; omitting world prompt context",
    );
    return null;
  }
})();

function workspaceSkillDir(skillName: string): string {
  return sandboxSkillDir(skillName);
}

function formatConfigurationValue(value: unknown): string {
  if (typeof value === "string") {
    return escapeXml(value);
  }

  try {
    return escapeXml(JSON.stringify(value));
  } catch {
    return escapeXml(String(value));
  }
}

function renderIdentityBlock(
  tag: "assistant" | "requester",
  fields: Record<string, string | undefined>,
): string[] {
  const lines = Object.entries(fields)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `- ${key}: ${escapeXml(value as string)}`);

  if (lines.length === 0) {
    return [`<${tag}>`, "none", `</${tag}>`];
  }

  return [`<${tag}>`, ...lines, `</${tag}>`];
}

function renderTag(tag: string, lines: string[]): string[] {
  return [`<${tag}>`, ...lines, `</${tag}>`];
}

function renderTagBlock(tag: string, content: string): string {
  return [`<${tag}>`, content, `</${tag}>`].join("\n");
}

function formatAvailableSkillsForPrompt(skills: SkillMetadata[]): string {
  if (skills.length === 0) {
    return "<available-skills>\n</available-skills>";
  }

  const lines = ["<available-skills>"];
  for (const skill of skills) {
    const skillLocation = `${workspaceSkillDir(skill.name)}/SKILL.md`;
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(
      `    <description>${escapeXml(skill.description)}</description>`,
    );
    lines.push(`    <location>${escapeXml(skillLocation)}</location>`);
    if (skill.pluginProvider) {
      lines.push(`    <provider>${escapeXml(skill.pluginProvider)}</provider>`);
    }
    lines.push("  </skill>");
  }
  lines.push("</available-skills>");
  return lines.join("\n");
}

function formatLoadedSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) {
    return "<loaded-skills>\n</loaded-skills>";
  }

  const lines = ["<loaded-skills>"];
  for (const skill of skills) {
    const skillDir = workspaceSkillDir(skill.name);
    lines.push(
      `  <skill name="${escapeXml(skill.name)}" location="${escapeXml(`${skillDir}/SKILL.md`)}">`,
    );
    lines.push(`References are relative to ${escapeXml(skillDir)}.`);
    lines.push("");
    lines.push(skill.body);
    lines.push("  </skill>");
  }
  lines.push("</loaded-skills>");
  return lines.join("\n");
}

function formatProviderCatalogForPrompt(): string | null {
  const providers = getPluginProviders().map((plugin) => plugin.manifest);
  if (providers.length === 0) {
    return null;
  }

  const lines = [
    "Config keys and default targets per provider; use after a skill is loaded.",
  ];
  for (const provider of providers) {
    lines.push(`- provider: ${escapeXml(provider.name)}`);
    lines.push(
      `  - config_keys: ${
        provider.configKeys.length > 0
          ? escapeXml(provider.configKeys.join(", "))
          : "none"
      }`,
    );
    lines.push(
      `  - default_context: ${
        provider.target
          ? escapeXml(
              `${provider.target.type} via ${provider.target.configKey}`,
            )
          : "none"
      }`,
    );
  }
  return lines.join("\n");
}

function formatActiveToolsForPrompt(
  tools: ExposedToolSummary[],
): string | null {
  if (tools.length === 0) {
    return null;
  }

  const lines = [
    "Active MCP tools available through `callMcpTool`. Pass the exact `tool_name`; `mcp_tool_name` is the upstream provider name.",
  ];
  for (const tool of tools) {
    lines.push("  <tool>");
    lines.push(`    <tool_name>${escapeXml(tool.tool_name)}</tool_name>`);
    lines.push(
      `    <mcp_tool_name>${escapeXml(tool.mcp_tool_name)}</mcp_tool_name>`,
    );
    lines.push(`    <provider>${escapeXml(tool.provider)}</provider>`);
    lines.push(`    <description>${escapeXml(tool.description)}</description>`);
    lines.push(
      `    <input_schema>${escapeXml(tool.input_schema_summary)}</input_schema>`,
    );
    lines.push("  </tool>");
  }
  return lines.join("\n");
}

function formatReferenceFilesLines(): string[] | null {
  const files = listReferenceFiles();
  if (files.length === 0) {
    return null;
  }

  return files.map((filePath) => {
    const name = path.basename(filePath);
    return `- ${escapeXml(name)} (${escapeXml(`${SANDBOX_DATA_ROOT}/${name}`)})`;
  });
}

function formatArtifactsLines(
  artifactState: ThreadArtifactsState | undefined,
): string[] | null {
  if (!artifactState) return null;
  const lines: string[] = [];
  if (artifactState.lastCanvasId) {
    lines.push(`- last_canvas_id: ${escapeXml(artifactState.lastCanvasId)}`);
  }
  if (artifactState.lastCanvasUrl) {
    lines.push(`- last_canvas_url: ${escapeXml(artifactState.lastCanvasUrl)}`);
  }
  if (artifactState.recentCanvases && artifactState.recentCanvases.length > 0) {
    lines.push("- recent_canvases:");
    for (const canvas of artifactState.recentCanvases) {
      lines.push(`  - id: ${escapeXml(canvas.id)}`);
      if (canvas.title) lines.push(`    title: ${escapeXml(canvas.title)}`);
      if (canvas.url) lines.push(`    url: ${escapeXml(canvas.url)}`);
      if (canvas.createdAt) {
        lines.push(`    created_at: ${escapeXml(canvas.createdAt)}`);
      }
    }
  }
  if (artifactState.lastListId) {
    lines.push(`- last_list_id: ${escapeXml(artifactState.lastListId)}`);
  }
  if (artifactState.lastListUrl) {
    lines.push(`- last_list_url: ${escapeXml(artifactState.lastListUrl)}`);
  }
  return lines.length > 0 ? lines : null;
}

function formatConfigurationLines(
  configuration: Record<string, unknown> | undefined,
): string[] | null {
  const keys = Object.keys(configuration ?? {}).sort((a, b) =>
    a.localeCompare(b),
  );
  if (keys.length === 0) return null;
  return keys.map(
    (key) =>
      `- ${escapeXml(key)}: ${formatConfigurationValue(configuration?.[key])}`,
  );
}

function formatThreadParticipantsLines(
  participants:
    | Array<{ userId?: string; userName?: string; fullName?: string }>
    | undefined,
): string[] | null {
  if (!participants || participants.length === 0) return null;
  return participants.map((p) => {
    const parts: string[] = [];
    if (p.userId) {
      parts.push(`user_id: ${escapeXml(p.userId)}`);
      parts.push(`slack_mention: <@${p.userId}>`);
    }
    if (p.userName) parts.push(`user_name: ${escapeXml(p.userName)}`);
    if (p.fullName) parts.push(`full_name: ${escapeXml(p.fullName)}`);
    return `- ${parts.join(", ")}`;
  });
}

const HEADER =
  "You are a Slack-based helper assistant. The behavior and output blocks below are authoritative; the personality block sets voice only.";

const BEHAVIOR_RULES = [
  "- When a request matches an available skill or tool, load the best-matching skill and use the relevant tool or command before answering or acting; don't load multiple up front; don't claim a skill or tool was used unless it was actually called this turn.",
  "- After loadSkill, resolve referenced paths under skill_dir, and call MCP tools with callMcpTool using exact `tool_name` values from `available_tools`; for preloaded or resumed skills, use <active-mcp-tools>.",
  "- Gather evidence with tools or skills before answering factual questions; say it is unverified rather than guess.",
  "- Execute clear tasks this turn; never ask the user to re-tag or re-invoke; when diagnosing tool availability or runtime failures, run the named tool or command, or a direct availability check, before reporting on it.",
  "- In thread follow-ups, answer from prior thread context; do not repeat resolved clarifying questions.",
  "- If the user asks what you just said, summarize your prior reply plainly.",
  "- Ask one direct clarifying question only when critical input cannot be discovered with tools.",
  "- Never narrate progress, prerequisite checks, or 'let me check'; never use reactions as progress signals — assistant status covers in-progress UX.",
  "- Prefer a single result-focused reply; send interim replies only when blocked or waiting on user input.",
  "- Do not claim an attachment, canvas, or channel post succeeded unless the tool returned success this turn; when it did, include any link the tool returned.",
  "- Run authenticated provider commands directly; the runtime handles auth pause/resume. Resolve target defaults first, and do not manage auth yourself.",
  "- After the runtime resumes a paused turn (auth completion, timeout-resume), post a brief continuation notice (e.g., 'Connected — continuing.') and then the resumed answer as a separate message.",
  "- If a command or prerequisite fails, report the exact command plus stderr/exit code; do not replace it with an inferred missing-tool or environment diagnosis.",
  "- Run `jr-rpc config get|set|unset|list` as its own bash command. It is a Junior runtime-intercepted config command for conversation-scoped keys from <providers> or active skill metadata, not a general sandbox binary.",
  "- For explicit channel-post or emoji-reaction requests, skip the text reply.",
];

function buildOutputSection(): string {
  const openTag = `<output format="slack-mrkdwn" max_inline_chars="${slackOutputPolicy.maxInlineChars}" max_inline_lines="${slackOutputPolicy.maxInlineLines}">`;
  return [
    openTag,
    "- Use Slack-friendly mrkdwn, not full CommonMark; use bolded section labels instead of markdown headings (# / ## / ###).",
    "- Use bullets and short code blocks when helpful; do not use markdown tables (| column |) or markdown links ([text](url)); prefer plain URLs.",
    "- Keep responses brief and scannable; for depth, lead with a concise summary and then provide fuller detail.",
    "- Prefer a single compact thread reply when the answer fits within the inline budget above.",
    "- When a research or document-style answer would benefit from continuation, multiple sections, or future reference value, create a Slack canvas and keep the thread reply to a short summary plus the canvas link.",
    "- End every turn with a final user-facing markdown response.",
    "</output>",
  ].join("\n");
}

function buildContextSection(params: {
  assistant?: { userName?: string; userId?: string };
  requester?: { userName?: string; fullName?: string; userId?: string };
  artifactState?: ThreadArtifactsState;
  configuration?: Record<string, unknown>;
  threadParticipants?: Array<{
    userId?: string;
    userName?: string;
    fullName?: string;
  }>;
  invocation: SkillInvocation | null;
  turnState?: "fresh" | "resumed";
}): string {
  const blocks: string[][] = [];

  if (JUNIOR_WORLD) {
    blocks.push(renderTag("world", [JUNIOR_WORLD.trim()]));
  }

  const referenceLines = formatReferenceFilesLines();
  if (referenceLines) {
    blocks.push(
      renderTag("reference-files", [
        "Additional reference documents available in the sandbox. Read them with `readFile` when relevant.",
        ...referenceLines,
      ]),
    );
  }

  const runtimeVersion = getRuntimeMetadata().version;
  if (runtimeVersion) {
    blocks.push([`<runtime version="${escapeXml(runtimeVersion)}" />`]);
  }

  blocks.push(
    renderIdentityBlock("assistant", {
      user_name: params.assistant?.userName ?? botConfig.userName,
      user_id: params.assistant?.userId,
    }),
  );

  blocks.push(
    renderIdentityBlock("requester", {
      full_name: params.requester?.fullName,
      user_name: params.requester?.userName,
      user_id: params.requester?.userId,
    }),
  );

  const participantLines = formatThreadParticipantsLines(
    params.threadParticipants,
  );
  if (participantLines) {
    blocks.push(
      renderTag("thread-participants", [
        "Known participants. When you mention one of these people, use the provided `<@USERID>` token exactly; do not write a bare `@name`.",
        ...participantLines,
      ]),
    );
  }

  const artifactLines = formatArtifactsLines(params.artifactState);
  if (artifactLines) {
    blocks.push(renderTag("artifacts", artifactLines));
  }

  const configLines = formatConfigurationLines(params.configuration);
  if (configLines) {
    blocks.push(
      renderTag("configuration", [
        "Conversation-scoped defaults. Follow explicit user input when it conflicts.",
        ...configLines,
      ]),
    );
  }

  if (params.turnState === "resumed") {
    blocks.push([
      "<turn-state>resumed</turn-state>",
      "This turn continues from a prior checkpoint. Prior tool results and assistant messages are already in the conversation history.",
    ]);
  }

  if (params.invocation) {
    blocks.push([
      `<explicit-skill-trigger>/${escapeXml(params.invocation.skillName)}</explicit-skill-trigger>`,
    ]);
  }

  const body = blocks.map((block) => block.join("\n")).join("\n\n");
  return renderTagBlock("context", body);
}

function buildCapabilitiesSection(params: {
  availableSkills: SkillMetadata[];
  activeSkills: Skill[];
  activeMcpTools: ExposedToolSummary[];
}): string {
  const blocks: string[] = [];
  blocks.push(formatAvailableSkillsForPrompt(params.availableSkills));
  blocks.push(formatLoadedSkillsForPrompt(params.activeSkills));

  const activeTools = formatActiveToolsForPrompt(params.activeMcpTools);
  if (activeTools) {
    blocks.push(renderTagBlock("active-mcp-tools", activeTools));
  }

  const providerCatalog = formatProviderCatalogForPrompt();
  if (providerCatalog) {
    blocks.push(renderTagBlock("providers", providerCatalog));
  }

  return renderTagBlock("capabilities", blocks.join("\n\n"));
}

export function buildSystemPrompt(params: {
  availableSkills: SkillMetadata[];
  activeSkills: Skill[];
  activeMcpTools?: ExposedToolSummary[];
  invocation: SkillInvocation | null;
  assistant?: {
    userName?: string;
    userId?: string;
  };
  requester?: {
    userName?: string;
    fullName?: string;
    userId?: string;
  };
  artifactState?: ThreadArtifactsState;
  configuration?: Record<string, unknown>;
  /**
   * Known thread participants: array of { userId, userName, fullName }.
   * Injected so the LLM can write correct <@USERID> mentions for people
   * already in the conversation without a separate API call.
   */
  threadParticipants?: Array<{
    userId?: string;
    userName?: string;
    fullName?: string;
  }>;
  /**
   * Whether this turn is a fresh prompt or a resume from a prior checkpoint
   * (OAuth pause or timeout-resume). Surfaced in <context> so the model knows
   * it is continuing rather than starting fresh.
   */
  turnState?: "fresh" | "resumed";
}): string {
  // Core harness contract:
  // - See specs/harness-agent-spec.md for the canonical agent-loop and terminal-output spec.
  // - Keep this prompt generic and platform-level (behavior, output contract, capability disclosure).
  // - Platform-level behavior rules must live here, never in SOUL.md (pluggable per deployment).
  // - Skill-specific instructions belong in skills/*/SKILL.md and are injected via <loaded-skills>.
  // - Pi-agent discloses only stable runtime tools natively. MCP tool catalogs
  //   are dynamic data, so expose them through loadSkill/<active-mcp-tools> and
  //   execute them through callMcpTool without mutating the native tool list.

  const sections = [
    HEADER,
    renderTagBlock("personality", JUNIOR_PERSONALITY.trim()),
    buildContextSection({
      assistant: params.assistant,
      requester: params.requester,
      artifactState: params.artifactState,
      configuration: params.configuration,
      threadParticipants: params.threadParticipants,
      invocation: params.invocation,
      turnState: params.turnState,
    }),
    buildCapabilitiesSection({
      availableSkills: params.availableSkills,
      activeSkills: params.activeSkills,
      activeMcpTools: params.activeMcpTools ?? [],
    }),
    renderTagBlock("behavior", BEHAVIOR_RULES.join("\n")),
    buildOutputSection(),
  ];

  return sections.join("\n\n");
}
