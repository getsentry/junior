import type { SlashCommandEvent } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

async function loadHandler() {
  vi.resetModules();
  return import("@/chat/ingress/slash-command");
}

function createSlashEvent(
  text: string,
  userOverrides: Partial<SlashCommandEvent["user"]> = {},
) {
  const postEphemeral = vi.fn(async () => {});
  const user = {
    userId: "U123",
    userName: "user",
    fullName: "User",
    isBot: false,
    isMe: false,
    ...userOverrides,
  };
  const event = {
    text,
    user,
    channel: { postEphemeral },
    raw: {},
  } as unknown as SlashCommandEvent;

  return { event, postEphemeral, user };
}

describe("slash command ingress", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("uses the configured slash command in usage text", async () => {
    process.env.JUNIOR_SLASH_COMMAND = "/team";
    const { handleSlashCommand } = await loadHandler();
    const { event, postEphemeral, user } = createSlashEvent("help");

    await handleSlashCommand(event);

    expect(postEphemeral).toHaveBeenCalledWith(
      user,
      "Usage: `/team link <provider>` or `/team unlink <provider>`",
      { fallbackToDM: false },
    );
  });

  it("uses the configured slash command in subcommand usage text", async () => {
    process.env.JUNIOR_SLASH_COMMAND = "/team";
    const { handleSlashCommand } = await loadHandler();
    const { event, postEphemeral, user } = createSlashEvent("link");

    await handleSlashCommand(event);

    expect(postEphemeral).toHaveBeenCalledWith(
      user,
      "Usage: `/team link <provider>`",
      { fallbackToDM: false },
    );
  });

  it("requires a Slack requester id before credential commands", async () => {
    const { handleSlashCommand } = await loadHandler();
    const { event } = createSlashEvent("link github", { userId: "" });

    await expect(handleSlashCommand(event)).rejects.toThrow(
      "Slack slash command requires a requester user id",
    );
  });

  it("rejects synthetic unknown requester ids before credential commands", async () => {
    const { handleSlashCommand } = await loadHandler();
    const { event } = createSlashEvent("link github", { userId: "unknown" });

    await expect(handleSlashCommand(event)).rejects.toThrow(
      "Slack slash command requires a requester user id",
    );
  });
});
