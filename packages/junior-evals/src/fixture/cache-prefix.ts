/**
 * Prompt cache prefix check for the agent requests of one test.
 *
 * Provider prompt caches key on the bytes of `tools`, then `system`, then
 * each message block. A request reads the cache only up to the first block
 * that differs from an earlier request, and writes the rest again. So each
 * agent request of a Conversation must start with every block of the one
 * before it. Cache markers may move. Context compaction is the one expected
 * history rewrite. Its summary requests branch off the prefix: they must
 * extend it, but the next agent request does not extend them.
 */
import { isContextSummaryRequestText } from "@/chat/agent/context-summary";
import { isCompactionSummaryText } from "@/chat/services/context-compaction-marker";

/** The cache-relevant parts of one Anthropic Messages request. */
export interface AgentGatewayRequest {
  model: string;
  system?: unknown;
  tools?: unknown;
  messages: Array<{ role: string; content: unknown }>;
  /** The `x-session-affinity` header: one session per Conversation. */
  sessionAffinity: string;
}

/** One request that does not extend the cached prefix it follows. */
interface CachePrefixBreak {
  /** Index of the request in the test. */
  request: number;
  part: "model" | "tools" | "system" | "messages";
  detail: string;
}

/** One message block, with its role and without its cache marker. */
interface PromptBlock {
  role: string;
  text?: unknown;
  json: string;
}

interface SeenRequest {
  request: AgentGatewayRequest;
  blocks: PromptBlock[];
}

function promptBlocks(request: AgentGatewayRequest): PromptBlock[] {
  return request.messages.flatMap(({ role, content }) => {
    const blocks: Record<string, unknown>[] = Array.isArray(content)
      ? content
      : [{ type: "text", text: content }];
    return blocks.map((block) => {
      const unmarked: Record<string, unknown> = { role, ...block };
      delete unmarked.cache_control;
      return { role, text: block.text, json: JSON.stringify(unmarked) };
    });
  });
}

function isText(
  block: PromptBlock,
  predicate: (text: string) => boolean,
): boolean {
  return typeof block.text === "string" && predicate(block.text);
}

function firstDifference(before: string, after: string): string {
  let index = 0;
  while (index < before.length && before[index] === after[index]) index += 1;
  const start = Math.max(0, index - 40);
  return `at char ${index}: ${JSON.stringify(before.slice(start, index + 40))} became ${JSON.stringify(after.slice(start, index + 40))}`;
}

function toolBreak(before: unknown, after: unknown): string | undefined {
  const beforeTools = (before ?? []) as Array<{ name: string }>;
  const afterTools = (after ?? []) as Array<{ name: string }>;
  const beforeNames = beforeTools.map((tool) => tool.name).join(",");
  const afterNames = afterTools.map((tool) => tool.name).join(",");
  if (beforeNames !== afterNames) {
    return `tool list changed from [${beforeNames}] to [${afterNames}]`;
  }
  for (const [index, tool] of beforeTools.entries()) {
    const beforeText = JSON.stringify(tool);
    const afterText = JSON.stringify(afterTools[index]);
    if (beforeText !== afterText) {
      return `tool ${tool.name} changed ${firstDifference(beforeText, afterText)}`;
    }
  }
  return undefined;
}

function blocksBreak(
  before: PromptBlock[],
  after: PromptBlock[],
): string | undefined {
  for (const [index, block] of before.entries()) {
    const next = after[index];
    if (!next) {
      return `history shrank from ${before.length} to ${after.length} blocks`;
    }
    if (block.json !== next.json) {
      return `block ${index} (${block.role}) changed ${firstDifference(block.json, next.json)}`;
    }
  }
  return undefined;
}

/** Whether `after` has a compaction summary that `before` does not have. */
function compactedBetween(before: SeenRequest, after: SeenRequest): boolean {
  const isSummary = (block: PromptBlock) =>
    isText(block, isCompactionSummaryText);
  const earlier = new Set(before.blocks.filter(isSummary).map((b) => b.json));
  return after.blocks.some(
    (block) => isSummary(block) && !earlier.has(block.json),
  );
}

function prefixBreak(
  before: SeenRequest,
  after: SeenRequest,
  blocks: PromptBlock[],
): Omit<CachePrefixBreak, "request"> | undefined {
  const previous = before.request;
  const next = after.request;
  if (previous.model !== next.model) {
    return { part: "model", detail: `${previous.model} became ${next.model}` };
  }
  const tools = toolBreak(previous.tools, next.tools);
  if (tools) return { part: "tools", detail: tools };
  const beforeSystem = JSON.stringify(previous.system);
  const afterSystem = JSON.stringify(next.system);
  if (beforeSystem !== afterSystem) {
    return {
      part: "system",
      detail: firstDifference(beforeSystem, afterSystem),
    };
  }
  if (compactedBetween(before, after)) return undefined;
  const messages = blocksBreak(before.blocks, blocks);
  return messages ? { part: "messages", detail: messages } : undefined;
}

/**
 * Find each agent request that does not start with the prefix that its
 * Conversation already cached.
 */
export function findCachePrefixBreaks(
  requests: readonly AgentGatewayRequest[],
): CachePrefixBreak[] {
  const breaks: CachePrefixBreak[] = [];
  const agentRequestsBySession = new Map<string, SeenRequest[]>();
  for (const [index, request] of requests.entries()) {
    const current: SeenRequest = { request, blocks: promptBlocks(request) };
    const earlier = agentRequestsBySession.get(request.sessionAffinity) ?? [];
    agentRequestsBySession.set(request.sessionAffinity, earlier);
    const summaryStart = current.blocks.findIndex((block) =>
      isText(block, isContextSummaryRequestText),
    );
    let before: SeenRequest | undefined;
    let blocks = current.blocks;
    if (summaryStart === -1) {
      before = earlier.at(-1);
      earlier.push(current);
    } else {
      // A summary request can run in the background from stored history, so
      // it extends the latest agent request that fits in that history.
      blocks = current.blocks.slice(0, summaryStart);
      before = [...earlier]
        .reverse()
        .find((agent) => agent.blocks.length <= blocks.length);
    }
    if (!before) continue;
    const found = prefixBreak(before, current, blocks);
    if (found) breaks.push({ request: index, ...found });
  }
  return breaks;
}
