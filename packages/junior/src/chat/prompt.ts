import fs from "node:fs";
import { listCapabilityProviders } from "@/chat/capabilities/catalog";
import { botConfig } from "@/chat/config";
import { aboutPathCandidates, soulPathCandidates } from "@/chat/discovery";
import { logInfo, logWarn } from "@/chat/logging";
import { slackOutputPolicy } from "@/chat/slack/output";
import type { RuntimeMetadata } from "@/chat/config";
import { sandboxSkillDir } from "@/chat/sandbox/paths";
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

function loadAbout(): string | null {
  return loadOptionalMarkdownFile(aboutPathCandidates(), "ABOUT.md");
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

export const JUNIOR_ABOUT = (() => {
  try {
    return loadAbout();
  } catch (error) {
    logWarn(
      "about_load_failed",
      {},
      {
        "error.message": error instanceof Error ? error.message : String(error),
      },
      "Failed to load ABOUT.md; omitting about prompt context",
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
): string {
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
    lines.push(
      `    <description>${escapeXml(skill.description)}</description>`,
    );
    lines.push(`    <location>${escapeXml(skillLocation)}</location>`);
    if (skill.usesConfig && skill.usesConfig.length > 0) {
      lines.push(
        `    <uses_config>${escapeXml(skill.usesConfig.join(" "))}</uses_config>`,
      );
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
    lines.push(
      `  <skill name="${escapeXml(skill.name)}" location="${escapeXml(`${skillDir}/SKILL.md`)}">`,
    );
    lines.push(`References are relative to ${escapeXml(skillDir)}.`);
    if (skill.requiresCapabilities && skill.requiresCapabilities.length > 0) {
      lines.push(
        `Requires capabilities: ${escapeXml(skill.requiresCapabilities.join(", "))}.`,
      );
    }
    if (skill.usesConfig && skill.usesConfig.length > 0) {
      lines.push(
        `Uses config keys: ${escapeXml(skill.usesConfig.join(", "))}.`,
      );
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
      }`,
    );
    lines.push(
      `  - capabilities: ${
        provider.capabilities.length > 0
          ? escapeXml(provider.capabilities.join(", "))
          : "none"
      }`,
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
    "- Keep user-visible progress communication concise and useful.",
    "- In thread follow-ups, answer using prior thread context directly; do not repeat unresolved clarifying questions unless the user asks to refine.",
    "- If the user asks what you just said or means by the previous answer, summarize your prior assistant reply plainly.",
    "- Never ask the user to re-tag or re-invoke for a clear task; continue execution in this turn.",
    "- Never claim you cannot access tools in this turn. If prior results are empty, run tools now.",
    "- If critical input is missing and cannot be discovered with tools, ask one direct clarifying question.",
    "- Always gather evidence from available sources (tools or skills) before answering factual questions.",
    "- When a loaded skill exposes MCP capabilities, those tools are registered as callable tools. Call them directly by name.",
    "- Use `searchTools` only when you need to rediscover or filter active MCP tools.",
    "- Never guess. If you cannot verify with available sources, say it is unverified.",
    "- Never claim a lookup succeeded unless a tool result supports it.",
    "- Do not give up when unsure how to do something; find a viable path, gather evidence, and provide the best actionable way forward.",
    "- When active skills are present, follow their instructions before default behavior.",
  ].join("\n");
}

export function buildSystemPrompt(params: {
  availableSkills: SkillMetadata[];
  activeSkills: Skill[];
  activeTools?: ExposedToolSummary[];
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
  runtimeMetadata?: RuntimeMetadata;
  /**
   * Known thread participants: array of { userId, userName, fullName }.
   * Injected into <identity-context> so the LLM can write correct <@USERID> mentions
   * for people already in the conversation without a separate API call.
   */
  threadParticipants?: Array<{
    userId?: string;
    userName?: string;
    fullName?: string;
  }>;
}): string {
  const {
    availableSkills,
    activeSkills,
    activeTools,
    invocation,
    requester,
    assistant,
    artifactState,
    configuration,
    relevantConfigurationKeys,
    runtimeMetadata,
    threadParticipants,
  } = params;
  // Core harness contract:
  // - See specs/harness-agent-spec.md for the canonical agent-loop and terminal-output spec.
  // - Keep this prompt generic and platform-level (tone, evidence, output constraints).
  // - Do not encode per-skill behavior here.
  // - Skill-specific instructions belong in skills/*/SKILL.md and are injected via active skill context.
  // - Delivery/runtime policies (for example forced attachments) belong in output/runtime code paths.

  const assistantSection = renderIdentityBlock("assistant", {
    user_name: assistant?.userName ?? botConfig.userName,
    user_id: assistant?.userId,
  });

  const requesterSection = renderIdentityBlock("requester", {
    full_name: requester?.fullName,
    user_name: requester?.userName,
    user_id: requester?.userId,
  });

  const availableSkillsSection = [
    "The following skills provide specialized instructions for specific tasks.",
    "Call `loadSkill` when the task matches a skill description.",
    "When a skill references a relative path, resolve it against `skill_dir` and use that path with `bash`.",
    "",
    formatAvailableSkillsForPrompt(availableSkills),
  ].join("\n");

  const activeSkillsSection = [
    "Loaded skills for this turn:",
    formatLoadedSkillsForPrompt(activeSkills),
  ].join("\n");
  const activeToolNames = (activeTools ?? []).map((tool) => tool.tool_name);
  const activeToolsSection =
    activeToolNames.length > 0
      ? `Active MCP tools registered for this turn: ${activeToolNames.join(", ")}. Call them directly by name.`
      : "";

  const configurationKeys = Object.keys(configuration ?? {}).sort((a, b) =>
    a.localeCompare(b),
  );
  const relevantConfigSet = new Set(
    (relevantConfigurationKeys ?? []).filter((key) =>
      Object.prototype.hasOwnProperty.call(configuration ?? {}, key),
    ),
  );
  const relevantConfigLines = configurationKeys
    .filter((key) => relevantConfigSet.has(key))
    .map(
      (key) =>
        `  - ${escapeXml(key)}: ${formatConfigurationValue(configuration?.[key])}`,
    );
  const otherConfigLines = configurationKeys
    .filter((key) => !relevantConfigSet.has(key))
    .map(
      (key) =>
        `  - ${escapeXml(key)}: ${formatConfigurationValue(configuration?.[key])}`,
    );

  const configurationSection = [
    "Use these conversation-scoped defaults when the user has not provided explicit values in this turn.",
    "If explicit user input conflicts with configuration, follow explicit user input.",
    configurationKeys.length === 0
      ? "- none"
      : [
          ...(relevantConfigLines.length > 0
            ? ["- relevant_for_active_skills:", ...relevantConfigLines]
            : []),
          ...(otherConfigLines.length > 0
            ? ["- other_available_keys:", ...otherConfigLines]
            : []),
        ].join("\n"),
  ].join("\n");

  const sections = [
    baseSystemPrompt(),
    renderTag(
      "personality",
      [
        "Always follow the personality guidance for tone/style unless safety or policy constraints require otherwise.",
        "",
        JUNIOR_PERSONALITY.trim(),
      ].join("\n"),
    ),
    ...(JUNIOR_ABOUT
      ? [
          renderTag(
            "about",
            [
              "Use this as the assistant's product/domain description when relevant.",
              "",
              JUNIOR_ABOUT.trim(),
            ].join("\n"),
          ),
        ]
      : []),
    renderTag(
      "identity-context",
      [
        "Use these blocks as authoritative metadata for identity questions.",
        assistantSection,
        requesterSection,
        ...(threadParticipants && threadParticipants.length > 0
          ? [
              renderTag(
                "thread-participants",
                [
                  "Known participants in this thread. When you mention one of these people, use the provided Slack mention token exactly as `<@USERID>` and do not write a bare `@name` form.",
                  ...threadParticipants.map((p) => {
                    const parts: string[] = [];
                    if (p.userId) {
                      parts.push(`user_id: ${escapeXml(p.userId)}`);
                      parts.push(`slack_mention: <@${p.userId}>`);
                    }
                    if (p.userName)
                      parts.push(`user_name: ${escapeXml(p.userName)}`);
                    if (p.fullName)
                      parts.push(`full_name: ${escapeXml(p.fullName)}`);
                    return `- ${parts.join(", ")}`;
                  }),
                ].join("\n"),
              ),
            ]
          : []),
      ].join("\n"),
    ),
    renderTag(
      "artifact-context",
      [
        "Use this thread-scoped memory for follow-up updates to existing Slack artifacts.",
        artifactState
          ? [
              artifactState.lastCanvasId
                ? `- last_canvas_id: ${escapeXml(artifactState.lastCanvasId)}`
                : "- last_canvas_id: none",
              artifactState.lastCanvasUrl
                ? `- last_canvas_url: ${escapeXml(artifactState.lastCanvasUrl)}`
                : "- last_canvas_url: none",
              artifactState.recentCanvases &&
              artifactState.recentCanvases.length > 0
                ? [
                    "- recent_canvases:",
                    ...artifactState.recentCanvases.map((canvas) =>
                      [
                        `  - id: ${escapeXml(canvas.id)}`,
                        canvas.title
                          ? `    title: ${escapeXml(canvas.title)}`
                          : "    title: [unknown]",
                        canvas.url
                          ? `    url: ${escapeXml(canvas.url)}`
                          : "    url: [unknown]",
                        canvas.createdAt
                          ? `    created_at: ${escapeXml(canvas.createdAt)}`
                          : "    created_at: [unknown]",
                      ].join("\n"),
                    ),
                  ].join("\n")
                : "- recent_canvases: none",
              artifactState.lastListId
                ? `- last_list_id: ${escapeXml(artifactState.lastListId)}`
                : "- last_list_id: none",
              artifactState.lastListUrl
                ? `- last_list_url: ${escapeXml(artifactState.lastListUrl)}`
                : "- last_list_url: none",
            ].join("\n")
          : "- none",
      ].join("\n"),
    ),
    renderTag("configuration-context", configurationSection),
    renderTag(
      "runtime-metadata",
      [
        "Use this for runtime version questions about the deployed assistant.",
        `- version: ${escapeXml(runtimeMetadata?.version ?? "unknown")}`,
      ].join("\n"),
    ),
    renderTag(
      "provider-capabilities",
      [
        "Use this catalog to map provider intents to valid config keys and capability names.",
        "When user intent is to set a provider default, choose a config key from this catalog and use jr-rpc config set.",
        formatProviderCatalogForPrompt(),
      ].join("\n"),
    ),
    renderTag(
      "tool-usage",
      [
        "- For factual or external questions, run tools/skills first, then answer from evidence.",
        "- Use tool descriptions as the source of truth for when each tool should or should not be called.",
        "- Use `bash` to inspect skill files from `skill_dir` and run shell commands inside the sandbox workspace.",
        "- When using CLI tools through `bash`, prefer deterministic non-interactive flags and avoid commands that wait for prompts or editors.",
        "- Keep routine setup and research steps silent in user-facing replies. Do not narrate duplicate checks, credential issuance, file writes, or similar internal progress unless the result is user-relevant.",
        "- If a routine prerequisite check finds nothing notable, omit it entirely from the final reply and report only the user-relevant outcome.",
        "- Prefer a single result-focused reply after tool work completes. Only send an interim reply when you need user input or have a concrete blocking problem to report.",
        "- Use `attachFile` for files that actually exist in the sandbox (for example screenshots, PDFs, logs), or for `attachment_path` values returned by `imageGenerate`.",
        "- If the user asks to see/share/show a screenshot or file, attach the file with `attachFile` instead of only reporting its path.",
        "- Never claim a screenshot/file is attached unless `attachFile` succeeded in this turn.",
        "- If `attachFile` fails, explain the failure and do not say the file was shared.",
        "- Use `imageGenerate` when the user asks for image creation.",
        "- `imageGenerate` returns generated image metadata, including `attachment_path` values you can pass to `attachFile` when the user should receive the image.",
        "- Use `slackCanvasCreate` for long-form docs/specs and `slackCanvasUpdate` for doc follow-ups.",
        "- `slackCanvasUpdate` targets the active artifact-context canvas automatically; do not ask the user for `canvas_id`.",
        "- When you create or update a Slack artifact in this turn (for example a canvas, list, posted message, or attached file), mention it explicitly in the final reply and include its link when the tool returned one.",
        "- Use `slackListCreate`, `slackListAddItems`, and `slackListUpdateItem` for actionable task tracking.",
        "- `slackListAddItems`, `slackListGetItems`, and `slackListUpdateItem` target the active artifact-context list automatically; do not ask the user for `list_id`.",
        "- If the user explicitly asks to post/send/share/say/show/announce/broadcast in the channel (outside this thread), call `slackChannelPostMessage` with the requested text instead of only replying in-thread.",
        "- For explicit in-channel post requests, prefer no thread text reply after a successful channel post. A reaction-only acknowledgment is acceptable when useful.",
        "- Use `slackMessageAddReaction` for rare lightweight acknowledgements. It reacts to the current inbound message via runtime context; never pick a target message yourself.",
        "- If the user explicitly asks for an emoji reaction instead of text, use `slackMessageAddReaction` with a Slack emoji alias name (for example `thumbsup`, `white_check_mark`, or `eyes`, not unicode emoji), and avoid redundant acknowledgment text.",
        "- Suggested acknowledgement reactions include `wave`, `white_check_mark`, `thumbsup`, and `eyes`, but choose what best fits the request.",
        "- If a loaded skill or `loadSkill` result declares `requires_capabilities`, run `jr-rpc issue-credential <capability> [--repo <owner/repo>]` as a bash command before authenticated bash/API work for that skill.",
        "- Use the minimum declared capability needed for the current operation.",
        "- If `jr-rpc issue-credential` returns `oauth_started`, relay its `message` to the user and stop. The runtime will resume after authorization.",
        "- For disconnect + reconnect requests, run `jr-rpc delete-token <provider>` first, then `jr-rpc issue-credential` — the system handles the reconnect without auto-resuming the reconnect message.",
        "- Use `jr-rpc oauth-start <provider>` only when the user explicitly asks to connect a provider and there is no task to resume after authorization.",
        "- GitHub capabilities need repository context, which can come from `--repo` or a configured `github.repo` default.",
        "- To persist or read conversation defaults (for example `github.repo`), run `jr-rpc config get|set|unset|list ...` as a bash command.",
        "- Capabilities are provider-qualified (for example `github.issues.write`).",
        "- When your work is complete, provide the exact user-facing markdown response.",
        "- Do not use reaction-based progress signals; Assistants API status already covers in-progress UX.",
        "- Prefer `webSearch` before `webFetch` when the user gave no URL.",
        "- Never call side-effecting tools when the user only asked for analysis or options.",
        "- `loadSkill` activates MCP tools when the loaded skill exposes them. After loading, call them directly by name (for example `mcp__provider__tool_name`).",
        "- `searchTools` searches active MCP tools exposed by currently loaded skills when you need to rediscover or filter them.",
        "- When the user asks for their conversation ID, trace ID, or a reference for Sentry lookup, use the IDs from `<session-context>` and `<turn-context>` in the user turn.",
      ].join("\n"),
    ),
    renderTag(
      "skills",
      [
        "- Explicit skill triggers may appear as `/skillname`.",
        "- If explicitly invoked skill instructions are already present in <loaded_skills>, apply them immediately.",
        "- If an explicitly invoked skill is present in <loaded_skills>, never say the skill is unavailable, missing, or unsupported in this environment.",
        "- Otherwise, for an explicitly invoked skill, call `loadSkill` for that exact skill before applying skill-specific behavior.",
        "- For requests without an explicit trigger where a skill clearly matches, call `loadSkill` before applying skill-specific behavior.",
        "- Do not claim to have used a skill unless it is present in <loaded_skills> or `loadSkill` succeeded in this turn.",
        "- Never apply skill-specific behavior unless the skill is present in <loaded_skills> or `loadSkill` succeeded in this turn.",
        "- Load only the best matching skill first; do not load multiple skills upfront.",
        "- After `loadSkill`, use `skill_dir` as the root for any referenced files you read via `bash`.",
        "- If a loaded skill exposes MCP tools, they are registered as callable tools after `loadSkill` returns. Call them directly by name.",
        "- Use `searchTools` only when you need to rediscover or filter the currently exposed MCP tools.",
        "- If no skill is a clear fit, continue with normal tool usage.",
      ].join("\n"),
    ),
    renderTag(
      "output-contract",
      [
        "Always produce output that follows this contract:",
        `<output format="slack-mrkdwn" max_inline_chars="${slackOutputPolicy.maxInlineChars}" max_inline_lines="${slackOutputPolicy.maxInlineLines}">`,
        "- Use plain Slack-safe markdown (headings, bullets, short code blocks).",
        "- Keep normal responses brief and scannable.",
        "- If depth is needed, start with a concise summary and then provide fuller detail.",
        "- A brief initial acknowledgment before significant tool work is fine; avoid extended process chatter or repeated status updates.",
        "- Avoid tables unless explicitly requested.",
        "- End every turn with a final user-facing markdown response.",
        "</output>",
      ].join("\n"),
    ),
    availableSkillsSection,
    activeSkillsSection,
    ...(activeToolsSection ? [activeToolsSection] : []),
    renderTag(
      "invocation-context",
      invocation
        ? `Explicit skill trigger detected: /${invocation.skillName}`
        : "No explicit skill trigger detected.",
    ),
  ];

  return sections.join("\n\n");
}
