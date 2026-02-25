import { generateText, tool } from "ai";
import { z } from "zod";
import { gateway } from "@ai-sdk/gateway";
import { findSkillByName, loadSkillsByName, type SkillMetadata } from "@/chat/skills";
import { webFetch, MAX_FETCH_CHARS } from "@/chat/tools/web_fetch";

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
    web_search: gateway.tools.parallelSearch({
      mode: "agentic"
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
    }),
    image_generate: tool({
      description: "Generate an image using AI Gateway (Gemini 3 Pro Image).",
      inputSchema: z.object({
        prompt: z.string().min(1).max(4000)
      }),
      execute: async ({ prompt }) => {
        try {
          const result = await generateText({
            model: gateway("google/gemini-3-pro-image"),
            prompt
          });

          const images = result.files
            .filter((file) => file.mediaType.startsWith("image/"))
            .map((file) => {
              const base64 = Buffer.from(file.uint8Array).toString("base64");

              return {
                media_type: file.mediaType,
                bytes: file.uint8Array.byteLength,
                data_url: `data:${file.mediaType};base64,${base64}`
              };
            });

          return {
            ok: true,
            model: "google/gemini-3-pro-image",
            prompt,
            image_count: images.length,
            images
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "image generation failed"
          };
        }
      }
    })
  };
}
