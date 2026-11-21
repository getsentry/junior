// The transcript views of the mock MCP tools: report events of the mock
// dashboard API mapped like `packages/junior/src/api/mcp/conversation.ts`.

/** Map message attachments to their MCP view, like `mcpAttachments`. */
export function mcpAttachments(attachments) {
  return attachments?.length
    ? attachments.map(({ bytes, contentType, filename }) => ({
        bytes,
        contentType,
        filename,
      }))
    : undefined;
}

/** A message author's display name, like `mcpAuthor`. */
export function mcpAuthor(identity) {
  return identity?.fullName ?? identity?.slackUserName ?? identity?.email;
}

/** Keep the user and assistant messages of report events, like `mcpMessages`. */
export function mcpMessages(events) {
  return events.flatMap((event) => {
    const data = event.data;
    if (data.type !== "message" || data.role === "system") return [];
    const text = data.text ?? "";
    const attachments = mcpAttachments(data.attachments);
    if (!text && !attachments) return [];
    return [
      {
        seq: event.seq,
        messageId: data.messageId,
        createdAt: event.createdAt,
        role: data.role,
        author: mcpAuthor(data.actorIdentity),
        text,
        attachments,
      },
    ];
  });
}

/**
 * Keep the reasoning and tool calls of report events, without tool input or
 * output, like `mcpActivity`.
 */
export function mcpActivity(events) {
  return events.flatMap((event) => {
    const data = event.data;
    const parts = [];
    if (data.type === "assistant_message") {
      for (const part of data.parts) {
        if (part.text) parts.push({ type: "reasoning", text: part.text });
      }
    } else if (data.type === "tool_calls") {
      const calls = new Map(data.calls.map((call) => [call.toolCallId, call]));
      const ordered =
        data.assistant?.parts ??
        data.calls.map((call) => ({
          type: "tool_call",
          toolCallId: call.toolCallId,
        }));
      for (const part of ordered) {
        if (part.type === "reasoning") {
          if (part.text) parts.push({ type: "reasoning", text: part.text });
          continue;
        }
        const call = calls.get(part.toolCallId);
        if (!call) continue;
        parts.push({
          type: "tool_call",
          toolCallId: call.toolCallId,
          name: call.name,
          status: call.status,
          startedAt: call.startedAt,
        });
      }
    }
    return parts.length > 0
      ? [{ seq: event.seq, createdAt: event.createdAt, parts }]
      : [];
  });
}
