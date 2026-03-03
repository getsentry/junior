import fs from "node:fs";
import path from "node:path";
import { listCapabilityProviders } from "@/chat/capabilities/catalog";
import { botConfig } from "@/chat/config";
import { slackOutputPolicy } from "@/chat/output";
import { sandboxSkillDir } from "@/chat/sandbox/paths";
import type { ThreadArtifactsState } from "@/chat/slack-actions/types";
import type { Skill, SkillMetadata, SkillInvocation } from "@/chat/skills";
import { escapeXml } from "@/chat/xml";

function loadSoul(): string {
  const soulPath = path.join(process.cwd(), "src", "chat", "SOUL.md");
  const raw = fs.readFileSync(soulPath, "utf8").trim();
  if (raw.length === 0) {
    throw new Error(`SOUL.md is empty: ${soulPath}`);
  }
  return raw;
}

export const JUNIOR_PERSONALITY = loadSoul();

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

function renderIdentityBlock(tag: "assistant" | "requester", fields: Record<string, string | undefined>): string {
  const lines = Object.entries(fields)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `- ${key}: ${escapeXml(value as string)}`);

  if (lines.length === 0) {
    return [`<${tag}>`, "none", `</${tag}>`].join("\n");
  }

  return [`<${tag}>`, ...lines, `</${tag}>`].join("\n");
}

function renderTag(tag: string, content: string): string {
  return [`<${tag}>`, content, `</${tag}>`].join("\n");
}

function formatAvailableSkillsForPrompt(skills: SkillMetadata[]): string {
  if (skills.length === 0) {
    return "<available_skills>\n</available_skills>";
  }

  const lines = ["<available_skills>"];
  for (const skill of skills) {
    const skillLocation = `${workspaceSkillDir(skill.name)}/SKILL.md`;
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skillLocation)}</location>`);
    if (skill.usesConfig && skill.usesConfig.length > 0) {
      lines.push(`    <uses_config>${escapeXml(skill.usesConfig.join(" "))}</uses_config>`);
    }
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function formatLoadedSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) {
    return "<loaded_skills>\n</loaded_skills>";
  }

  const lines = ["<loaded_skills>"];
  for (const skill of skills) {
    const skillDir = workspaceSkillDir(skill.name);
    lines.push(`  <skill name="${escapeXml(skill.name)}" location="${escapeXml(`${skillDir}/SKILL.md`)}">`);
    lines.push(`References are relative to ${escapeXml(skillDir)}.`);
    if (skill.usesConfig && skill.usesConfig.length > 0) {
      lines.push(`Uses config keys: ${escapeXml(skill.usesConfig.join(", "))}.`);
    }
    lines.push("");
    lines.push(skill.body);
    lines.push("  </skill>");
  }
  lines.push("</loaded_skills>");
  return lines.join("\n");
}

function formatProviderCatalogForPrompt(): string {
  const providers = listCapabilityProviders();
  if (providers.length === 0) {
    return "- none";
  }

  const lines: string[] = [];
  for (const provider of providers) {
    lines.push(`- provider: ${escapeXml(provider.provider)}`);
    lines.push(
      `  - config_keys: ${
        provider.configKeys.length > 0
          ? escapeXml(provider.configKeys.join(", "))
          : "none"
      }`
    );
    lines.push(
      `  - capabilities: ${
        provider.capabilities.length > 0
          ? escapeXml(provider.capabilities.join(", "))
          : "none"
      }`
    );
  }
  return lines.join("\n");
}

function baseSystemPrompt(): string {
  return [
    "You are a Slack-based helper assistant.",
    "Identity, tone, and domain defaults are defined in the personality block.",
    "",
    "- Be concise, practical, and specific.",
    "- Prefer actionable next steps over generic explanations.",
    "- When the user gives a clear task, execute it immediately in this turn.",
    "- Do not ask for permission to proceed when the request is already clear.",
    "- When your response requires significant work (multiple tool calls, sandbox execution), lead with a brief one-line acknowledgment so the user sees immediate feedback. Do not give ongoing status updates or ask permission to proceed.",
    "- Never ask the user to re-tag or re-invoke for a clear task; continue execution in this turn.",
    "- Never claim you cannot access tools in this turn. If prior results are empty, run tools now.",
    "- If critical input is missing and cannot be discovered with tools, ask one direct clarifying question.",
    "- Always gather evidence from available sources (tools or skills) before answering factual questions.",
    "- Never guess. If you cannot verify with available sources, say it is unverified.",
    "- Never claim a lookup succeeded unless a tool result supports it.",
    "- Do not give up when unsure how to do something; find a viable path, gather evidence, and provide the best actionable way forward.",
    "- When active skills are present, follow their instructions before default behavior."
  ].join("\n");
}

export function buildSystemPrompt(params: {
  availableSkills: SkillMetadata[];
  activeSkills: Skill[];
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
  relevantConfigurationKeys?: string[];
}): string {
  const {
    availableSkills,
    activeSkills,
    invocation,
    requester,
    assistant,
    artifactState,
    configuration,
    relevantConfigurationKeys
  } = params;
  // Core harness contract:
  // - See specs/harness-agent-spec.md for the canonical agent-loop and terminal-output spec.
  // - Keep this prompt generic and platform-level (tone, evidence, output constraints).
  // - Do not encode per-skill behavior here.
  // - Skill-specific instructions belong in skills/*/SKILL.md and are injected via active skill context.
  // - Delivery/runtime policies (for example forced attachments) belong in output/runtime code paths.

  const assistantSection = renderIdentityBlock("assistant", {
    user_name: assistant?.userName ?? botConfig.userName,
    user_id: assistant?.userId
  });

  const requesterSection = renderIdentityBlock("requester", {
    full_name: requester?.fullName,
    user_name: requester?.userName,
    user_id: requester?.userId
  });

  const availableSkillsSection = [
    "The following skills provide specialized instructions for specific tasks.",
    "Call `loadSkill` when the task matches a skill description.",
    "When a skill references a relative path, resolve it against `skill_dir` and use that path with `bash`.",
    "",
    formatAvailableSkillsForPrompt(availableSkills)
  ].join("\n");

  const activeSkillsSection = [
    "Loaded skills for this turn:",
    formatLoadedSkillsForPrompt(activeSkills)
  ].join("\n");

  const configurationKeys = Object.keys(configuration ?? {}).sort((a, b) => a.localeCompare(b));
  const relevantConfigSet = new Set(
    (relevantConfigurationKeys ?? []).filter((key) => Object.prototype.hasOwnProperty.call(configuration ?? {}, key))
  );
  const relevantConfigLines = configurationKeys
    .filter((key) => relevantConfigSet.has(key))
    .map((key) => `  - ${escapeXml(key)}: ${formatConfigurationValue(configuration?.[key])}`);
  const otherConfigLines = configurationKeys
    .filter((key) => !relevantConfigSet.has(key))
    .map((key) => `  - ${escapeXml(key)}: ${formatConfigurationValue(configuration?.[key])}`);

  const configurationSection = [
    "Use these conversation-scoped defaults when the user has not provided explicit values in this turn.",
    "If explicit user input conflicts with configuration, follow explicit user input.",
    configurationKeys.length === 0
      ? "- none"
      : [
          ...(relevantConfigLines.length > 0 ? ["- relevant_for_active_skills:", ...relevantConfigLines] : []),
          ...(otherConfigLines.length > 0 ? ["- other_available_keys:", ...otherConfigLines] : [])
        ].join("\n")
  ].join("\n");

  const sections = [
    baseSystemPrompt(),
    renderTag(
      "personality",
      [
        "Always follow the personality guidance for tone/style unless safety or policy constraints require otherwise.",
        "",
        JUNIOR_PERSONALITY.trim()
      ].join("\n")
    ),
    renderTag(
      "identity-context",
      [
        "Use these blocks as authoritative metadata for identity questions.",
        assistantSection,
        requesterSection
      ].join("\n")
    ),
    renderTag(
      "artifact-context",
      [
        "Use this thread-scoped memory for follow-up updates to existing Slack artifacts.",
        artifactState
          ? [
              artifactState.lastCanvasId ? `- last_canvas_id: ${escapeXml(artifactState.lastCanvasId)}` : "- last_canvas_id: none",
              artifactState.lastCanvasUrl
                ? `- last_canvas_url: ${escapeXml(artifactState.lastCanvasUrl)}`
                : "- last_canvas_url: none",
              artifactState.recentCanvases && artifactState.recentCanvases.length > 0
                ? [
                    "- recent_canvases:",
                    ...artifactState.recentCanvases.map((canvas) =>
                      [
                        `  - id: ${escapeXml(canvas.id)}`,
                        canvas.title ? `    title: ${escapeXml(canvas.title)}` : "    title: [unknown]",
                        canvas.url ? `    url: ${escapeXml(canvas.url)}` : "    url: [unknown]",
                        canvas.createdAt ? `    created_at: ${escapeXml(canvas.createdAt)}` : "    created_at: [unknown]"
                      ].join("\n")
                    )
                  ].join("\n")
                : "- recent_canvases: none",
              artifactState.lastListId ? `- last_list_id: ${escapeXml(artifactState.lastListId)}` : "- last_list_id: none",
              artifactState.lastListUrl ? `- last_list_url: ${escapeXml(artifactState.lastListUrl)}` : "- last_list_url: none"
            ].join("\n")
          : "- none"
      ].join("\n")
    ),
    renderTag("configuration-context", configurationSection),
    renderTag(
      "provider-capabilities",
      [
        "Use this catalog to map provider intents to valid config keys and capability names.",
        "When user intent is to set a provider default, choose a config key from this catalog and use jr-rpc config set.",
        formatProviderCatalogForPrompt()
      ].join("\n")
    ),
    renderTag(
      "tool-usage",
      [
        "- For factual or external questions, run tools/skills first, then answer from evidence.",
        "- Use tool descriptions as the source of truth for when each tool should or should not be called.",
        "- Use `bash` to inspect skill files from `skill_dir` and run shell commands inside the sandbox workspace.",
        "- Use `imageGenerate` when the user asks for image creation.",
        "- Use `slackCanvasCreate` for long-form docs/specs and `slackCanvasUpdate` for doc follow-ups.",
        "- `slackCanvasUpdate` targets the active artifact-context canvas automatically; do not ask the user for `canvas_id`.",
        "- Use `slackListCreate`, `slackListAddItems`, and `slackListUpdateItem` for actionable task tracking.",
        "- `slackListAddItems`, `slackListGetItems`, and `slackListUpdateItem` target the active artifact-context list automatically; do not ask the user for `list_id`.",
        "- If the user explicitly asks to post/send/share/say a message in the channel (outside this thread), call `slackChannelPostMessage` with the requested text instead of only replying in-thread.",
        "- To enable provider credentials for this turn, run `jr-rpc issue-credential <capability> [--repo <owner/repo>]` as a bash command before commands that need authenticated API calls.",
        "- To persist or read conversation defaults (for example `github.repo`), run `jr-rpc config get|set|unset|list ...` as a bash command.",
        "- Capabilities are provider-qualified (for example `github.issues.write`).",
        "- When your work is complete, provide the exact user-facing markdown response.",
        "- Do not use reaction-based progress signals; Assistants API status already covers in-progress UX.",
        "- Prefer `webSearch` before `webFetch` when the user gave no URL.",
        "- Never call side-effecting tools when the user only asked for analysis or options."
      ].join("\n")
    ),
    renderTag(
      "skills",
      [
        "- For explicit slash commands, treat `/skill-name` as authoritative intent for that skill.",
        "- If slash-invoked skill instructions are already present in <loaded_skills>, apply them immediately.",
        "- Otherwise, for slash-invoked skills, call `loadSkill` for that exact skill before applying skill-specific behavior.",
        "- For non-slash requests where a skill clearly matches, call `loadSkill` before applying skill-specific behavior.",
        "- Do not claim to have used a skill unless it is present in <loaded_skills> or `loadSkill` succeeded in this turn.",
        "- Never apply skill-specific behavior unless the skill is present in <loaded_skills> or `loadSkill` succeeded in this turn.",
        "- Load only the best matching skill first; do not load multiple skills upfront.",
        "- After `loadSkill`, use `skill_dir` as the root for any referenced files you read via `bash`.",
        "- If no skill is a clear fit, continue with normal tool usage."
      ].join("\n")
    ),
    renderTag(
      "output-contract",
      [
        "Always produce output that follows this contract:",
        `<output format=\"slack-mrkdwn\" max_inline_chars=\"${slackOutputPolicy.maxInlineChars}\" max_inline_lines=\"${slackOutputPolicy.maxInlineLines}\">`,
        "- Use plain Slack-safe markdown (headings, bullets, short code blocks).",
        "- Keep normal responses brief and scannable.",
        "- If depth is needed, start with a concise summary and then provide fuller detail.",
        "- A brief initial acknowledgment before significant tool work is fine; avoid extended process chatter or repeated status updates.",
        "- Avoid tables unless explicitly requested.",
        "- End every turn with a final user-facing markdown response.",
        "</output>"
      ].join("\n")
    ),
    availableSkillsSection,
    activeSkillsSection,
    renderTag(
      "invocation-context",
      invocation ? `Slash invocation detected: /${invocation.skillName}` : "No slash invocation detected."
    )
  ];

  return sections.join("\n\n");
}
