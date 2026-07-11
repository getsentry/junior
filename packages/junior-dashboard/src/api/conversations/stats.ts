import { readConversationStats } from "@sentry/junior/api/conversations/stats";

/** Serve aggregate conversation stats from the durable SQL API. */
export async function conversationStatsResponse(): Promise<Response> {
  try {
    return Response.json(await readConversationStats());
  } catch (error) {
    console.error("Failed to load conversation stats", error);
    return Response.json(
      { error: "Conversation stats failed to load." },
      { status: 500 },
    );
  }
}
