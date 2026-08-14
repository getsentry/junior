import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const url = requiredEnvironment("JUNIOR_ACP_URL");
const token = requiredEnvironment("JUNIOR_ACP_TOKEN");
const prompt =
  process.env.JUNIOR_ACP_PROMPT?.trim() ||
  "Reply with a short confirmation that remote ACP works.";
const savedSessionId = process.env.JUNIOR_ACP_SESSION_ID?.trim();
const followUp = process.env.JUNIOR_ACP_FOLLOW_UP?.trim();

async function withConnection<T>(
  run: (context: acp.ClientContext) => Promise<T>,
): Promise<T> {
  const stream = createHttpStream(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  try {
    return await acp
      .client({ name: "junior-acp-smoke" })
      .onNotification(acp.methods.client.session.update, (context) => {
        const update = context.params.update;
        if (
          (update.sessionUpdate === "user_message_chunk" ||
            update.sessionUpdate === "agent_message_chunk") &&
          update.content.type === "text"
        ) {
          process.stdout.write(
            `[${update.sessionUpdate}] ${update.content.text}\n`,
          );
        }
      })
      .connectWith(stream, run);
  } finally {
    await stream.writable.close().catch(() => undefined);
  }
}

async function initialize(context: acp.ClientContext): Promise<void> {
  const result = await context.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: "junior-acp-smoke", version: "1" },
  });
  if (result.agentCapabilities?.loadSession !== true) {
    throw new Error("Junior did not advertise session/load support");
  }
}

const sessionId = await withConnection(async (context) => {
  await initialize(context);
  if (savedSessionId) {
    await context.request(acp.methods.agent.session.load, {
      sessionId: savedSessionId,
      cwd: process.cwd(),
      mcpServers: [],
    });
  }
  const activeSessionId =
    savedSessionId ??
    (
      await context.request(acp.methods.agent.session.new, {
        cwd: process.cwd(),
        mcpServers: [],
      })
    ).sessionId;
  const result = await context.request(acp.methods.agent.session.prompt, {
    sessionId: activeSessionId,
    prompt: [{ type: "text", text: prompt }],
  });
  process.stdout.write(`[stop] ${result.stopReason}\n`);
  return activeSessionId;
});

process.stdout.write(`[session] ${sessionId}\n`);

await withConnection(async (context) => {
  await initialize(context);
  await context.request(acp.methods.agent.session.load, {
    sessionId,
    cwd: process.cwd(),
    mcpServers: [],
  });
  process.stdout.write("[reconnect] load complete\n");
  if (followUp) {
    const result = await context.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: followUp }],
    });
    process.stdout.write(`[follow-up stop] ${result.stopReason}\n`);
  }
});
