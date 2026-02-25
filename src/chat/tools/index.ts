import { generateText, tool } from "ai";
import type { FileUpload } from "chat";
import { z } from "zod";
import { gateway } from "@ai-sdk/gateway";
import { createCanvas, lookupCanvasSection, updateCanvas } from "@/chat/slack-actions/canvases";
import {
  addListItems,
  createTodoList,
  listItems,
  updateListItem
} from "@/chat/slack-actions/lists";
import type { ThreadArtifactsState } from "@/chat/slack-actions/types";
import { findSkillByName, loadSkillsByName, type SkillMetadata } from "@/chat/skills";
import { webFetch, MAX_FETCH_CHARS } from "@/chat/tools/web_fetch";

export interface ToolHooks {
  onGeneratedFiles?: (files: FileUpload[]) => void;
  onArtifactStatePatch?: (patch: Partial<ThreadArtifactsState>) => void;
}

export interface ToolRuntimeContext {
  channelId?: string;
  threadTs?: string;
  artifactState?: ThreadArtifactsState;
}

function extensionForMediaType(mediaType: string): string {
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  if (mediaType === "image/gif") return "gif";
  return "bin";
}

function isEnabled(value: string | undefined, defaultValue = true): boolean {
  if (!value) return defaultValue;
  return value.toLowerCase() === "true";
}

function getDefaultCanvasId(context: ToolRuntimeContext): string | undefined {
  return context.artifactState?.lastCanvasId;
}

function getDefaultListId(context: ToolRuntimeContext): string | undefined {
  return context.artifactState?.lastListId;
}

export function createTools(
  availableSkills: SkillMetadata[],
  hooks: ToolHooks = {},
  context: ToolRuntimeContext = {}
) {
  const canvasesEnabled = isEnabled(process.env.SLACK_CANVASES_ENABLED);
  const listsEnabled = isEnabled(process.env.SLACK_LISTS_ENABLED);

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
    }),
    slack_canvas_create: tool({
      description: "Create a Slack canvas for long-form output in the current channel.",
      inputSchema: z.object({
        title: z.string().min(1).max(160),
        markdown: z.string().min(1),
        channel_id: z.string().min(1).optional()
      }),
      execute: async ({ title, markdown, channel_id }) => {
        if (!canvasesEnabled) {
          return { ok: false, error: "Slack canvas tools are disabled" };
        }

        try {
          const created = await createCanvas({
            title,
            markdown,
            channelId: channel_id ?? context.channelId
          });
          hooks.onArtifactStatePatch?.({ lastCanvasId: created.canvasId, lastCanvasUrl: created.permalink });

          return {
            ok: true,
            canvas_id: created.canvasId,
            permalink: created.permalink,
            summary: `Created canvas ${created.canvasId}`
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "canvas create failed"
          };
        }
      }
    }),
    slack_canvas_update: tool({
      description: "Update a Slack canvas using insert or replace operations.",
      inputSchema: z.object({
        canvas_id: z.string().min(1).optional(),
        markdown: z.string().min(1),
        operation: z.enum(["insert_at_end", "insert_at_start", "replace"]).default("insert_at_end"),
        section_id: z.string().min(1).optional(),
        section_contains_text: z.string().min(1).optional()
      }),
      execute: async ({ canvas_id, markdown, operation, section_id, section_contains_text }) => {
        if (!canvasesEnabled) {
          return { ok: false, error: "Slack canvas tools are disabled" };
        }

        try {
          const targetCanvasId = canvas_id ?? getDefaultCanvasId(context);
          if (!targetCanvasId) {
            return { ok: false, error: "No canvas_id provided and no prior canvas found in thread state" };
          }

          const sectionId =
            section_id ??
            (section_contains_text ? await lookupCanvasSection(targetCanvasId, section_contains_text) : undefined);

          await updateCanvas({
            canvasId: targetCanvasId,
            markdown,
            operation,
            sectionId
          });
          hooks.onArtifactStatePatch?.({ lastCanvasId: targetCanvasId });

          return {
            ok: true,
            canvas_id: targetCanvasId,
            operation,
            section_id: sectionId
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "canvas update failed"
          };
        }
      }
    }),
    slack_list_create: tool({
      description: "Create a Slack todo list for action tracking.",
      inputSchema: z.object({
        name: z.string().min(1).max(160)
      }),
      execute: async ({ name }) => {
        if (!listsEnabled) {
          return { ok: false, error: "Slack list tools are disabled" };
        }

        try {
          const list = await createTodoList(name);
          hooks.onArtifactStatePatch?.({
            lastListId: list.listId,
            lastListUrl: list.permalink,
            listColumnMap: list.listColumnMap
          });

          return {
            ok: true,
            list_id: list.listId,
            permalink: list.permalink,
            column_map: list.listColumnMap
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "list create failed"
          };
        }
      }
    }),
    slack_list_add_items: tool({
      description: "Add one or more todo items to a Slack list.",
      inputSchema: z.object({
        list_id: z.string().min(1).optional(),
        items: z.array(z.string().min(1)).min(1).max(25),
        assignee_user_id: z.string().min(1).optional(),
        due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
      }),
      execute: async ({ list_id, items, assignee_user_id, due_date }) => {
        if (!listsEnabled) {
          return { ok: false, error: "Slack list tools are disabled" };
        }

        try {
          const targetListId = list_id ?? getDefaultListId(context);
          if (!targetListId) {
            return { ok: false, error: "No list_id provided and no prior list found in thread state" };
          }

          const result = await addListItems({
            listId: targetListId,
            titles: items,
            listColumnMap: context.artifactState?.listColumnMap,
            assigneeUserId: assignee_user_id,
            dueDate: due_date
          });

          hooks.onArtifactStatePatch?.({
            lastListId: targetListId,
            listColumnMap: result.listColumnMap
          });

          return {
            ok: true,
            list_id: targetListId,
            created_item_ids: result.createdItemIds,
            created_count: result.createdItemIds.length
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "list item create failed"
          };
        }
      }
    }),
    slack_list_get_items: tool({
      description: "List items from a Slack list.",
      inputSchema: z.object({
        list_id: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(200).default(100)
      }),
      execute: async ({ list_id, limit }) => {
        if (!listsEnabled) {
          return { ok: false, error: "Slack list tools are disabled" };
        }

        try {
          const targetListId = list_id ?? getDefaultListId(context);
          if (!targetListId) {
            return { ok: false, error: "No list_id provided and no prior list found in thread state" };
          }

          const items = await listItems(targetListId, limit);

          return {
            ok: true,
            list_id: targetListId,
            items: items.map((item) => ({ id: item.id, fields: item.fields }))
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "list fetch failed"
          };
        }
      }
    }),
    slack_list_update_item: tool({
      description: "Update an existing Slack list item (completion state or title).",
      inputSchema: z
        .object({
          list_id: z.string().min(1).optional(),
          item_id: z.string().min(1),
          completed: z.boolean().optional(),
          title: z.string().min(1).optional()
        })
        .refine((value) => value.completed !== undefined || value.title !== undefined, {
          message: "Provide at least one field to update: completed or title"
        }),
      execute: async ({ list_id, item_id, completed, title }) => {
        if (!listsEnabled) {
          return { ok: false, error: "Slack list tools are disabled" };
        }

        try {
          const targetListId = list_id ?? getDefaultListId(context);
          if (!targetListId) {
            return { ok: false, error: "No list_id provided and no prior list found in thread state" };
          }

          await updateListItem({
            listId: targetListId,
            itemId: item_id,
            completed,
            title,
            listColumnMap: context.artifactState?.listColumnMap ?? {}
          });

          hooks.onArtifactStatePatch?.({ lastListId: targetListId });

          return {
            ok: true,
            list_id: targetListId,
            item_id,
            completed,
            title
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "list item update failed"
          };
        }
      }
    })
  };
}
