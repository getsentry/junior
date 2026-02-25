import fs from "node:fs";
import path from "node:path";
import { botConfig } from "@/chat/config";
import { slackOutputPolicy } from "@/chat/output";
import type { ThreadArtifactsState } from "@/chat/slack-actions/types";
import type { Skill, SkillMetadata, SkillInvocation } from "@/chat/skills";

function loadSoul(): string {
  const soulPath = path.join(process.cwd(), "src", "chat", "SOUL.md");
  const raw = fs.readFileSync(soulPath, "utf8").trim();
  if (raw.length === 0) {
    throw new Error(`SOUL.md is empty: ${soulPath}`);
  }
  return raw;
}

const JUNIOR_PERSONALITY = loadSoul();

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderIdentityBlock(tag: "assistant" | "requester", fields: Record<string, string | undefined>): string {
  const lines = Object.entries(fields)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `- ${key}: ${escapeXml(value as string)}`);

  if (lines.length === 0) {
    return `<${tag} />`;
  }

  return [`<${tag}>`, ...lines, `</${tag}>`].join("\n");
}

function baseSystemPrompt(): string {
  return [
    "## Core Principles",
    "",
    "You are a general-purpose helper assistant for Slack.",
    "",
    "- Be concise, practical, and specific.",
    "- Prefer actionable next steps over generic explanations.",
    "- If data is missing, ask for the exact identifier you need.",
    "- Always gather evidence from available sources (tools or skills) before answering factual questions.",
    "- Never guess. If you cannot verify with available sources, say it is unverified.",
    "- Never claim a lookup succeeded unless a tool result supports it.",
    "- Do not give up when unsure how to do something; find a viable path, gather evidence, and provide the best actionable way forward.",
    "- When active skills are present, follow their instructions before default behavior."
  ].join(" ");
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
  chatHistory?: string;
  artifactState?: ThreadArtifactsState;
}): string {
  const { availableSkills, activeSkills, invocation, requester, assistant, chatHistory, artifactState } = params;
  // Core harness contract:
  // - Keep this prompt generic and platform-level (tone, evidence, output constraints).
  // - Do not encode per-skill behavior here.
  // - Skill-specific instructions belong in skills/*/SKILL.md and are injected via active skill context.
  // - Delivery/runtime policies (for example forced attachments) belong in output/runtime code paths.

  const assistantSection = renderIdentityBlock("assistant", {
    user_name: assistant?.userName ?? botConfig.userName,
    user_id: assistant?.userId ?? botConfig.slackBotUserId
  });

  const requesterSection = renderIdentityBlock("requester", {
    full_name: requester?.fullName,
    user_name: requester?.userName,
    user_id: requester?.userId
  });

  const availableSkillsSection =
    availableSkills.length === 0
      ? "## Available Skills\n\n- none configured"
      : [
          "## Available Skills",
          "",
          ...availableSkills.map((skill) => `- /${skill.name}: ${skill.description}`)
        ].join("\n");

  const activeSkillsSection =
    activeSkills.length === 0
      ? "## Active Skills\n\n- none"
      : [
          "## Active Skills",
          "",
          ...activeSkills.flatMap((skill) => [
            `<active_skill name="${escapeXml(skill.name)}">`,
            skill.body,
            "</active_skill>",
            ""
          ])
        ].join("\n");

  return [
    baseSystemPrompt(),
    "## Personality",
    "",
    "Always follow the personality guidance for tone/style unless safety or policy constraints require otherwise.",
    "",
    "<personality>",
    JUNIOR_PERSONALITY.trim(),
    "</personality>",
    "## Identity Context",
    "",
    "Use these blocks as authoritative metadata for identity questions.",
    assistantSection,
    requesterSection,
    "## Chat History",
    "",
    "Use this as recent thread context when answering follow-up questions.",
    "<chat_history>",
    chatHistory?.trim() || "none",
    "</chat_history>",
    "## Artifact Context",
    "",
    "Use this thread-scoped memory for follow-up updates to existing Slack artifacts.",
    "<artifact_context>",
    artifactState
      ? [
          artifactState.lastCanvasId ? `- last_canvas_id: ${escapeXml(artifactState.lastCanvasId)}` : "- last_canvas_id: none",
          artifactState.lastCanvasUrl
            ? `- last_canvas_url: ${escapeXml(artifactState.lastCanvasUrl)}`
            : "- last_canvas_url: none",
          artifactState.lastListId ? `- last_list_id: ${escapeXml(artifactState.lastListId)}` : "- last_list_id: none",
          artifactState.lastListUrl ? `- last_list_url: ${escapeXml(artifactState.lastListUrl)}` : "- last_list_url: none"
        ].join("\n")
      : "- none",
    "</artifact_context>",
    "## Tool Usage",
    "",
    "- For factual or external questions, run tools/skills first, then answer from evidence.",
    "- Use `load_skill` when task-specific instructions are needed.",
    "- Use `web_search` to discover sources.",
    "- Use `web_fetch` to inspect specific URLs.",
    "- Use `image_generate` when the user asks for image creation.",
    "- Use `slack_canvas_create` for long-form docs/specs and `slack_canvas_update` for doc follow-ups.",
    "- Use `slack_list_create`, `slack_list_add_items`, and `slack_list_update_item` for actionable task tracking.",
    "- Do not use reaction-based progress signals; Assistants API status already covers in-progress UX.",
    "- Prefer `web_search` before `web_fetch` when the user gave no URL.",
    "## Output Contract",
    "",
    "Always produce output that follows this contract:",
    `<output format=\"slack-mrkdwn\" max_inline_chars=\"${slackOutputPolicy.maxInlineChars}\" max_inline_lines=\"${slackOutputPolicy.maxInlineLines}\">`,
    "- Use plain Slack-safe markdown (headings, bullets, short code blocks).",
    "- Keep normal responses brief and scannable.",
    "- If depth is needed, start with a concise summary and then provide fuller detail.",
    "- Avoid tables unless explicitly requested.",
    "- Optional delivery directive (only when needed) must be the first block in this exact shape:",
    "- <delivery>",
    "- mode: attachment|inline",
    "- attachment_prefix: <short-kebab-or-snake-prefix>",
    "- </delivery>",
    "</output>",
    "## Skill Invocation",
    "",
    "- If the full user message starts with `/<skill-name>`, treat it as an explicit skill command.",
    "- Never reinterpret explicit slash skill commands as plain chat intent.",
    "- If skill is unknown, return an unknown-skill error and list available skills.",
    availableSkillsSection,
    activeSkillsSection,
    invocation
      ? `## Invocation Context\n\nSlash invocation detected: /${invocation.skillName}`
      : "## Invocation Context\n\nNo slash invocation detected."
  ].join("\n\n");
}
