import * as acp from "@agentclientprotocol/sdk";
import {
  MemoryAcpCookieStore,
  createHttpStream,
} from "@agentclientprotocol/sdk/experimental/http-client";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const url = requiredEnvironment("JUNIOR_ACP_URL");
const prompt =
  process.env.JUNIOR_ACP_PROMPT?.trim() ||
  "Reply with a short confirmation that remote ACP works.";
const savedSessionId = process.env.JUNIOR_ACP_SESSION_ID?.trim();
const followUp = process.env.JUNIOR_ACP_FOLLOW_UP?.trim();
const autoAuthorize = process.env.JUNIOR_ACP_AUTO_AUTHORIZE === "true";
const cookieStore = new MemoryAcpCookieStore();

async function authorize(
  params: acp.CreateElicitationRequest,
): Promise<acp.CreateElicitationResponse> {
  if (params.mode !== "url" || typeof params.url !== "string") {
    return { action: "decline" };
  }
  process.stdout.write(`[sign-in] ${params.message ?? ""} ${params.url}\n`);
  if (autoAuthorize) {
    const userCode = params.message?.match(
      /\b[0-9A-F]{4}(?:-[0-9A-F]{4}){2}\b/,
    )?.[0];
    if (!userCode) {
      throw new Error("ACP sign-in elicitation returned no verification code");
    }
    const url = new URL(params.url);
    const response = await fetch(url, {
      method: "POST",
      headers: { Origin: url.origin },
      body: new URLSearchParams({ code: userCode }),
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(`ACP sign-in returned HTTP ${response.status}`);
    }
  }
  return { action: "accept" };
}

async function withConnection<T>(
  run: (context: acp.ClientContext) => Promise<T>,
): Promise<T> {
  const stream = createHttpStream(url, {
    cookieStore,
  });
  try {
    return await acp
      .client({ name: "junior-acp-smoke" })
      .onRequest(acp.methods.client.elicitation.create, (context) =>
        authorize(context.params),
      )
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
    clientCapabilities: { elicitation: { url: {} } },
    clientInfo: { name: "junior-acp-smoke", version: "1" },
  });
  if (result.agentCapabilities?.loadSession !== true) {
    throw new Error("Junior did not advertise session/load support");
  }
  const method = result.authMethods?.find(
    (candidate) => candidate.id === "junior",
  );
  if (!method) throw new Error("Junior did not advertise browser sign-in");
  await context.request(acp.methods.agent.authenticate, {
    methodId: method.id,
  });
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
