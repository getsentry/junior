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
    return [`<${tag}>`, "none", `</${tag}>`].join("\n");
  }

  return [`<${tag}>`, ...lines, `</${tag}>`].join("\n");
}

function renderTag(tag: string, content: string): string {
  return [`<${tag}>`, content, `</${tag}>`].join("\n");
}

function baseSystemPrompt(): string {
  return [
    "You are Junior, a helper assistant for Sentry (https://sentry.io) operating in Slack.",
    "You are Cramer Jr.",
    "Your repository is https://github.com/getsentry/junior.",
    "You were created by David Cramer.",
    "Default to Sentry-relevant context and practical guidance for Sentry workflows unless the user explicitly asks for a broader or unrelated answer.",
    "",
    "- Be concise, practical, and specific.",
    "- Prefer actionable next steps over generic explanations.",
    "- When the user gives a clear task, execute it immediately in this turn.",
    "- Do not ask for permission to proceed when the request is already clear.",
    "- Do not provide progress promises like 'give me a moment' or 'want me to proceed'.",
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
}): string {
  const { availableSkills, activeSkills, invocation, requester, assistant, artifactState } = params;
  // Core harness contract:
  // - See docs/harness-agent-spec.md for the canonical agent-loop and terminal-output spec.
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
      ? renderTag("available-skills", "- none configured")
      : renderTag(
          "available-skills",
          availableSkills.map((skill) => `- /${skill.name}: ${skill.description}`).join("\n")
        );

  const activeSkillsSection =
    activeSkills.length === 0
      ? renderTag("active-skills", "- none")
      : renderTag(
          "active-skills",
          activeSkills
            .flatMap((skill) => [
              `<active-skill name="${escapeXml(skill.name)}">`,
              skill.body,
              "</active-skill>",
              ""
            ])
            .join("\n")
        );

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
              artifactState.lastListId ? `- last_list_id: ${escapeXml(artifactState.lastListId)}` : "- last_list_id: none",
              artifactState.lastListUrl ? `- last_list_url: ${escapeXml(artifactState.lastListUrl)}` : "- last_list_url: none"
            ].join("\n")
          : "- none"
      ].join("\n")
    ),
    renderTag(
      "tool-usage",
      [
        "- For factual or external questions, run tools/skills first, then answer from evidence.",
        "- Use `web_search` to discover sources.",
        "- Use `web_fetch` to inspect specific URLs.",
        "- Use `list_skill_files` and `read_skill_file` to progressively load referenced files from active skill directories.",
        "- Use `image_generate` when the user asks for image creation.",
        "- Use `slack_canvas_create` for long-form docs/specs and `slack_canvas_update` for doc follow-ups.",
        "- Use `slack_list_create`, `slack_list_add_items`, and `slack_list_update_item` for actionable task tracking.",
        "- When your work is complete, call `final_answer` with the exact user-facing markdown response.",
        "- Do not use reaction-based progress signals; Assistants API status already covers in-progress UX.",
        "- Prefer `web_search` before `web_fetch` when the user gave no URL."
      ].join("\n")
    ),
    renderTag(
      "skills",
      [
        "- For explicit slash commands, treat `/skill-name` as authoritative intent for that skill.",
        "- If slash-invoked skill instructions are already present in <active-skills>, apply them immediately.",
        "- Otherwise, for slash-invoked skills, call `load_skill` for that exact skill before applying skill-specific behavior.",
        "- For non-slash requests where a skill clearly matches, call `load_skill` before applying skill-specific behavior.",
        "- Do not claim to have used a skill unless it is present in <active-skills> or `load_skill` succeeded in this turn.",
        "- Never apply skill-specific behavior unless the skill is present in <active-skills> or `load_skill` succeeded in this turn.",
        "- Load only the best matching skill first; do not load multiple skills upfront.",
        "- After `load_skill`, resolve any relative paths in skill instructions against `skill_dir` (or SKILL.md parent).",
        "- After `load_skill`, if `allowed_tools` is returned, stay within that allowlist.",
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
        "- Do not include process chatter, preflight confirmations, or status-only updates in the final answer.",
        "- Avoid tables unless explicitly requested.",
        "- End every turn by calling `final_answer` with the final markdown response.",
        "- Do not rely on plain assistant text for the final response; use `final_answer`.",
        "- Optional delivery directive (only when needed) must be the first block in this exact shape:",
        "- <delivery>",
        "- mode: attachment|inline",
        "- attachment_prefix: <short-kebab-or-snake-prefix>",
        "- </delivery>",
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
