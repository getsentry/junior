import fs from "node:fs";
import path from "node:path";
import type { WebClient, KnownBlock, SectionBlock } from "@slack/web-api";
import { homeDir } from "@/chat/home";
import { getPluginProviders } from "@/chat/plugins/registry";
import { discoverSkills } from "@/chat/skills";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { getRuntimeMetadata } from "@/chat/runtime-metadata";

interface HomeView {
  type: "home";
  blocks: KnownBlock[];
}

const DEFAULT_ABOUT_TEXT = "I help your team investigate, summarize, and act on work in Slack.";
const MAX_HOME_SKILLS = 6;
const MAX_SECTION_TEXT_CHARS = 3000;
const HIDDEN_HOME_SKILLS = new Set(["jr-rpc"]);

function clampSectionText(text: string): string {
  if (text.length <= MAX_SECTION_TEXT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_SECTION_TEXT_CHARS - 1)}…`;
}

function loadAboutText(): string {
  const aboutPath = path.join(homeDir(), "ABOUT.md");
  try {
    const raw = fs.readFileSync(aboutPath, "utf8").trim();
    if (raw.length > 0) {
      return clampSectionText(raw);
    }
  } catch {
    // Use fallback when ABOUT.md is absent.
  }
  return DEFAULT_ABOUT_TEXT;
}

async function buildSkillsSummaryText(): Promise<string> {
  const skills = (await discoverSkills()).filter((skill) => !HIDDEN_HOME_SKILLS.has(skill.name));
  if (skills.length === 0) {
    return "No skills installed.";
  }

  const visible = skills.slice(0, MAX_HOME_SKILLS);
  const lines = visible.map((skill) => `• *${skill.name}* — ${skill.description}`);
  if (skills.length > visible.length) {
    lines.push(`• …and ${skills.length - visible.length} more`);
  }
  return lines.join("\n");
}

export async function buildHomeView(
  userId: string,
  userTokenStore: UserTokenStore
): Promise<HomeView> {
  const runtimeMetadata = getRuntimeMetadata();
  const aboutText = loadAboutText();
  const skillsSummaryText = await buildSkillsSummaryText();
  const providers = getPluginProviders();
  const connectedSections: SectionBlock[] = [];

  for (const plugin of providers) {
    if (plugin.manifest.credentials?.type !== "oauth-bearer") continue;

    const tokens = await userTokenStore.get(userId, plugin.manifest.name);
    if (!tokens) continue;

    connectedSections.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${plugin.manifest.name}*\n${plugin.manifest.description}`
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Unlink" },
        action_id: "app_home_disconnect",
        value: plugin.manifest.name,
        style: "danger"
      }
    });
  }

  const accountBlocks: KnownBlock[] = connectedSections.length > 0
    ? connectedSections
    : [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "No connected accounts"
          }
        }
      ];

  return {
    type: "home",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Junior"
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: aboutText
        }
      },
      { type: "divider" },
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "What I can help with"
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: skillsSummaryText
        }
      },
      { type: "divider" },
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Connected accounts"
        }
      },
      ...accountBlocks,
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `*junior version:* \`${runtimeMetadata.version ?? "unknown"}\``
          }
        ]
      }
    ]
  };
}

export async function publishAppHomeView(
  slackClient: WebClient,
  userId: string,
  userTokenStore: UserTokenStore
): Promise<void> {
  const view = await buildHomeView(userId, userTokenStore);
  await slackClient.views.publish({ user_id: userId, view });
}
