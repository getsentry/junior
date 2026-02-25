import { tool } from "ai";
import { z } from "zod";
import { findSkillByName, loadSkillsByName, type SkillMetadata } from "@/chat/skills";
import { webFetch, MAX_FETCH_CHARS } from "@/chat/tools/web_fetch";
import { webSearch } from "@/chat/tools/web_search";

export function createTools(availableSkills: SkillMetadata[]) {
  return {
    load_skill: tool({
      description: "Load a named skill and return its instructions to the reasoning context.",
      inputSchema: z.object({
        skill_name: z.string().min(1)
      }),
      execute: async ({ skill_name }) => {
        const meta = findSkillByName(skill_name, availableSkills);
        if (!meta) {
          return {
            ok: false,
            error: `Unknown skill: ${skill_name}`,
            available_skills: availableSkills.map((skill) => skill.name)
          };
        }

        const [skill] = await loadSkillsByName([meta.name], availableSkills);

        return {
          ok: true,
          skill_name: skill.name,
          description: skill.description,
          location: `${skill.skillPath}/SKILL.md`,
          instructions: skill.body
        };
      }
    }),
    web_search: tool({
      description: "Search the web for a query and return top results.",
      inputSchema: z.object({
        query: z.string().min(2),
        limit: z.number().int().min(1).max(10).optional()
      }),
      execute: async ({ query, limit }) => {
        try {
          return await webSearch(query, limit);
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "search failed"
          };
        }
      }
    }),
    web_fetch: tool({
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
    })
  };
}
