import { generateText, tool } from "ai";
import type { FileUpload } from "chat";
import { z } from "zod";
import { gateway } from "@ai-sdk/gateway";
import { findSkillByName, loadSkillsByName, type SkillMetadata } from "@/chat/skills";
import { webFetch, MAX_FETCH_CHARS } from "@/chat/tools/web_fetch";

export interface ToolHooks {
  onGeneratedFiles?: (files: FileUpload[]) => void;
}

function extensionForMediaType(mediaType: string): string {
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  if (mediaType === "image/gif") return "gif";
  return "bin";
}

export function createTools(availableSkills: SkillMetadata[], hooks: ToolHooks = {}) {
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

          const uploads = result.files
            .filter((file) => file.mediaType.startsWith("image/"))
            .map((file, index) => {
              const extension = extensionForMediaType(file.mediaType);
              const filename = `generated-image-${Date.now()}-${index + 1}.${extension}`;
              return {
                data: Buffer.from(file.uint8Array),
                filename,
                mimeType: file.mediaType
              };
            });

          if (uploads.length > 0) {
            hooks.onGeneratedFiles?.(uploads);
          }

          return {
            ok: true,
            model: "google/gemini-3-pro-image",
            prompt,
            image_count: uploads.length,
            images: uploads.map((upload) => ({
              filename: upload.filename,
              media_type: upload.mimeType,
              bytes: Buffer.isBuffer(upload.data) ? upload.data.byteLength : 0
            })),
            delivery: "Images will be attached to the Slack response as files."
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
