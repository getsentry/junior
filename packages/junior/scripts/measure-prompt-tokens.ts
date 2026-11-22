/**
 * Measure the always-on prompt: the system prompt and tool definitions that
 * the first model request of every Turn sends. This is test equipment.
 *
 * It runs one local `junior chat` Turn of the app in the working directory
 * through the real wiring, fakes only the AI Gateway, and reads the request
 * that Pi serializes. Run it through `scripts/prompt-tokens.mjs`, which sets
 * the working directory and env. The first argument is the JSON output path.
 */
import { writeFile } from "node:fs/promises";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { runChat } from "@/cli/chat";
import { runUpgrade } from "@/cli/upgrade";
import { estimateModelTextTokens } from "@/chat/services/token-estimate";
import { CAPABILITY_SECTION_TAG } from "@/chat/turn-context-tag";

const GATEWAY_ORIGIN = "https://ai-gateway.vercel.sh";
const PROMPT = "Reply with ok.";
// The core headings of the system prompt (see `system-prompt-rules.ts`).
// Other headings belong to the consumer's SOUL.md or WORLD.md and stay in
// their section.
const CORE_HEADINGS = new Map([
  ["# Identity", "Identity"],
  ["# Personality", "Personality"],
  ["# World", "World"],
]);
const OPEN_TAG = /^<([a-z][a-z0-9-]*)(?: [^>]*)?>$/;
const CAPABILITY_TAGS = new Set<string>(Object.values(CAPABILITY_SECTION_TAG));

interface AnthropicTool {
  name: string;
  cache_control?: unknown;
  [field: string]: unknown;
}

interface AnthropicRequest {
  model: string;
  system?: Array<{ type: string; text: string }>;
  tools?: AnthropicTool[];
  messages: Array<{ role: string; content: unknown }>;
}

interface Measured {
  name: string;
  chars: number;
  tokens: number;
}

// One Anthropic text response, so the Turn ends after its first request.
function textResponse(model: string) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "measure",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "ok" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  return HttpResponse.text(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** Split the system prompt into its top-level blocks, in prompt order. */
function splitSystemPrompt(
  text: string,
): Array<{ name: string; text: string }> {
  const sections = [{ name: "header", lines: [] as string[] }];
  let closingTag: string | undefined;
  for (const line of text.split("\n")) {
    const current = sections.at(-1)!;
    if (closingTag) {
      current.lines.push(line);
      if (line === closingTag) closingTag = undefined;
      continue;
    }
    const tag = OPEN_TAG.exec(line)?.[1];
    const heading = CORE_HEADINGS.get(line);
    if (tag || heading) {
      sections.push({ name: tag ?? heading!, lines: [line] });
      closingTag = tag ? `</${tag}>` : undefined;
      continue;
    }
    current.lines.push(line);
  }
  return sections.map(({ name, lines }) => ({ name, text: lines.join("\n") }));
}

function sectionGroup(name: string): string {
  if (name === "Personality" || name === "World") return name.toLowerCase();
  if (name === "plugin-system-context") return "plugins";
  if (CAPABILITY_TAGS.has(name)) return name;
  return "rules";
}

// Each `<skill>` entry of `<available-skills>`.
function splitSkills(section: string): Array<{ name: string; text: string }> {
  return [...section.matchAll(/^ {2}<skill>\n[\s\S]*?^ {2}<\/skill>$/gm)].map(
    ([entry]) => ({
      name: /<name>(.*)<\/name>/.exec(entry)?.[1] ?? "unknown",
      text: entry,
    }),
  );
}

function measure(name: string, text: string, model: string): Measured {
  return {
    name,
    chars: text.length,
    tokens: estimateModelTextTokens(text, model),
  };
}

async function captureAgentRequest(): Promise<AnthropicRequest> {
  const requests: AnthropicRequest[] = [];
  const server = setupServer(
    http.post(`${GATEWAY_ORIGIN}/v1/messages`, async ({ request }) => {
      const body = (await request.json()) as AnthropicRequest;
      requests.push(body);
      return textResponse(body.model);
    }),
    // Embeddings and side model calls do not change the agent request.
    http.post(`${GATEWAY_ORIGIN}/*`, () =>
      HttpResponse.json({ error: "Not faked" }, { status: 503 }),
    ),
  );
  // Any other request would make the measurement depend on the network.
  server.listen({ onUnhandledRequest: "error" });
  try {
    await runUpgrade({ info: () => undefined });
    const exitCode = await runChat(["-p", PROMPT], {
      error: (line) => void process.stderr.write(`${line}\n`),
      input: process.stdin,
      output: process.stdout,
      write: () => undefined,
    });
    if (exitCode !== 0) throw new Error(`The Turn failed (exit ${exitCode})`);
  } finally {
    server.close();
  }
  // The title request has no tools.
  const agentRequest = requests.find((request) => request.tools?.length);
  if (!agentRequest) throw new Error("The Turn sent no agent model request");
  return agentRequest;
}

async function main(): Promise<void> {
  const outputPath = process.argv[2];
  if (!outputPath)
    throw new Error("usage: measure-prompt-tokens <output.json>");

  const request = await captureAgentRequest();
  const model = request.model;
  const system = (request.system ?? []).map((block) => block.text).join("\n\n");
  const sections = splitSystemPrompt(system);
  // Cache markers are request metadata, not definition text.
  const tools = (request.tools ?? []).map((definition) => {
    const tool = { ...definition };
    delete tool.cache_control;
    return tool;
  });
  const skills = splitSkills(
    sections.find(({ name }) => name === CAPABILITY_SECTION_TAG.availableSkills)
      ?.text ?? "",
  );
  // Text messages before the current instruction: the Turn context. It
  // changes on each request, so it is not part of the always-on total.
  const turnContext = request.messages
    .slice(0, -1)
    .map((message) => JSON.stringify(message.content))
    .join("");

  const stats = {
    // `STATS_VERSION` in scripts/prompt-tokens.mjs, which reads the stats.
    version: 1,
    model,
    sections: sections.map(({ name, text }) => ({
      ...measure(name, text, model),
      group: sectionGroup(name),
    })),
    tools: tools
      .map((tool) => measure(tool.name, JSON.stringify(tool), model))
      .sort((a, b) => b.chars - a.chars),
    skills: skills
      .map(({ name, text }) => measure(name, text, model))
      .sort((a, b) => b.chars - a.chars),
    turnContext: measure("turn context", turnContext, model),
  };
  await writeFile(outputPath, `${JSON.stringify(stats, null, 2)}\n`);
}

await main();
// Local chat leaves state handles open.
process.exit(0);
