import { tool } from "ai";
import { z } from "zod";
import { webFetch, MAX_FETCH_CHARS } from "@/chat/tools/web_fetch";

export function createWebFetchTool() {
  return tool({
    description: "Fetch and extract readable text from a URL.",
    inputSchema: z.object({
      url: z.string().url(),
      max_chars: z.number().int().min(500).max(MAX_FETCH_CHARS).optional()
    }),
    execute: async ({ url, max_chars }) => {
      try {
        return await webFetch(url, max_chars);
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "fetch failed"
        };
      }
    }
  });
}
