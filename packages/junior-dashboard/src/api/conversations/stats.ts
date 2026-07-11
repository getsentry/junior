/** Serve aggregate conversation stats from the durable SQL API. */
export async function conversationStatsResponse(): Promise<Response> {
  try {
    const { readConversationStats } =
      await import("@sentry/junior/api/conversations/stats");
    return Response.json(await readConversationStats());
  } catch (error) {
    console.error("Failed to load conversation stats", error);
    return Response.json(
      { error: "Conversation stats failed to load." },
      { status: 500 },
    );
  }
}
