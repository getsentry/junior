import {
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  googleFileRequest,
  MAX_CONTENT_CHARS,
  parseFileReference,
} from "./files";
import { readRequesterFile } from "./file-access";
import type { GoogleToolContext } from "./shared";
import {
  presentationReferenceSchema,
  presentationUrl,
  slideObjectIdSchema,
} from "./slides";

// The whole deck at full detail is often too long for one result, so it
// returns an outline: element ids, sizes, positions, shape types, and text.
// One slide returns every field, including text and shape styles.
const DECK_FIELDS =
  "revisionId,pageSize,slides(objectId,slideProperties(layoutObjectId,isSkipped,notesPage(notesProperties,pageElements(objectId,shape(text(textElements(textRun(content))))))),pageElements(objectId,size,transform,title,description,shape(shapeType,placeholder(type),text(textElements(textRun(content)))),table(rows,columns),image(sourceUrl),line(lineCategory),elementGroup(children(objectId)),sheetsChart(spreadsheetId,chartId)))";

const inputSchema = z
  .object({
    presentation: presentationReferenceSchema,
    slide_object_id: slideObjectIdSchema
      .optional()
      .describe(
        "Read one slide with every field, including text and shape styles. Omit to read an outline of every slide.",
      ),
    fields: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .optional()
      .describe(
        "Slides API field mask, such as 'slides(objectId,pageElements(objectId,shape(text)))'. Omit for the default. revision_id is returned when your account can edit the presentation.",
      ),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("readGoogleSlidesLayout"),
  content: z
    .unknown()
    .describe(
      "Slides API JSON of the presentation, or of one slide (a Page). Sizes and positions are in EMU: 12700 EMU is 1 point.",
    ),
  presentation_id: z.string(),
  revision_id: z
    .string()
    .optional()
    .describe(
      "Pass it as revision_id to updateGoogleSlides. Google returns it only when your account can edit the presentation.",
    ),
  title: z.string(),
  url: z.string(),
});

const revisionSchema = z.object({ revisionId: z.string().optional() }).loose();

/** Read the Slides API JSON of a presentation or one slide, for edits. */
export const readGoogleSlidesLayoutTool = definePluginTool({
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: true,
  },
  description:
    "Read the layout of a Google Slides presentation as your own Google account sees it: object ids, sizes, positions, shape types, text, and styles, plus the revision that updateGoogleSlides needs. Use it before you edit Slides. To see a slide, use getGoogleSlideThumbnail. Contents can be private: share only what the requester needs.",
  inputSchema,
  outputSchema,
  async execute(input, _options, ctx: GoogleToolContext) {
    const ref = parseFileReference(input.presentation);
    const file = await readRequesterFile(ctx, ref, ["presentation"]);
    const fields =
      input.fields && !/\brevisionId\b/.test(input.fields)
        ? `revisionId,${input.fields}`
        : input.fields;
    const response = input.slide_object_id
      ? await googleFileRequest(ctx, ref, {
          operation: "google.slides.page.get",
          path: `/v1/presentations/${ref.fileId}/pages/${input.slide_object_id}`,
          ...(fields ? { query: { fields } } : undefined),
        })
      : await googleFileRequest(ctx, ref, {
          operation: "google.slides.presentation.get",
          path: `/v1/presentations/${ref.fileId}`,
          query: { fields: fields ?? DECK_FIELDS },
        });
    if (JSON.stringify(response.body).length > MAX_CONTENT_CHARS) {
      throw new PluginToolInputError(
        `The layout of "${file.name}" is longer than ${MAX_CONTENT_CHARS} characters. Read one slide with slide_object_id, or pass a narrower fields mask.`,
      );
    }
    const { revisionId } = revisionSchema.parse(response.body);
    return {
      target: "readGoogleSlidesLayout" as const,
      content: response.body,
      presentation_id: ref.fileId,
      ...(revisionId ? { revision_id: revisionId } : undefined),
      title: file.name,
      url: file.webViewLink ?? presentationUrl(ref.fileId),
    };
  },
});
