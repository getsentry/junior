// oxlint-disable anti-slop/no-shape-in-symbol-names -- `shape` is a Slides API field.
import * as z from "zod";
import {
  googleFileRequest,
  MAX_CONTENT_CHARS,
  type FileReference,
} from "./files";
import type { GoogleToolContext } from "./shared";

/** Output fields of `readGoogleFile` for Slides. */
export const slidesOutputFields = {
  slide_count: z.number().int().optional().describe("Only for Slides."),
  slides: z
    .array(
      z.object({
        notes: z.string().optional().describe("Speaker notes."),
        slide_number: z.number().int(),
        text: z
          .string()
          .describe(
            "Text in the shapes and tables of the slide. Images and charts are not described.",
          ),
      }),
    )
    .optional()
    .describe("Only for Slides."),
};

const textSchema = z
  .object({
    textElements: z
      .array(
        z.object({
          textRun: z.object({ content: z.string().optional() }).optional(),
        }),
      )
      .default([]),
  })
  .optional();

interface PageElement {
  elementGroup?: { children?: PageElement[] };
  objectId?: string;
  shape?: { text?: z.infer<typeof textSchema> };
  table?: {
    tableRows?: { tableCells?: { text?: z.infer<typeof textSchema> }[] }[];
  };
}

const pageElementSchema: z.ZodType<PageElement> = z.lazy(() =>
  z.object({
    elementGroup: z
      .object({ children: z.array(pageElementSchema).optional() })
      .optional(),
    objectId: z.string().optional(),
    shape: z.object({ text: textSchema }).optional(),
    table: z
      .object({
        tableRows: z
          .array(
            z.object({
              tableCells: z.array(z.object({ text: textSchema })).optional(),
            }),
          )
          .optional(),
      })
      .optional(),
  }),
);

const presentationSchema = z.object({
  slides: z
    .array(
      z.object({
        pageElements: z.array(pageElementSchema).default([]),
        slideProperties: z
          .object({
            notesPage: z
              .object({
                notesProperties: z
                  .object({ speakerNotesObjectId: z.string().optional() })
                  .optional(),
                pageElements: z.array(pageElementSchema).default([]),
              })
              .optional(),
          })
          .optional(),
      }),
    )
    .default([]),
});

function plainText(text: z.infer<typeof textSchema>): string {
  return (text?.textElements ?? [])
    .map((element) => element.textRun?.content ?? "")
    .join("")
    .trim();
}

/** Return the text of one page element, with tables as `|` rows. */
function elementText(element: PageElement): string[] {
  if (element.shape) {
    return [plainText(element.shape.text)];
  }
  if (element.table) {
    return (element.table.tableRows ?? []).map((row) =>
      (row.tableCells ?? []).map((cell) => plainText(cell.text)).join(" | "),
    );
  }
  return (element.elementGroup?.children ?? []).flatMap(elementText);
}

/**
 * Read the text and speaker notes of each slide in one Google Slides file.
 *
 * This uses the Slides API to keep slide numbers and speaker notes. It
 * accepts the same `drive.readonly` scope as the Drive tools.
 */
export async function readSlidesContent(
  ctx: GoogleToolContext,
  ref: FileReference,
) {
  const response = await googleFileRequest(ctx, ref, {
    operation: "google.slides.presentation.get",
    path: `/v1/presentations/${ref.fileId}`,
    query: {
      fields:
        "slides(pageElements,slideProperties/notesPage(notesProperties,pageElements))",
    },
  });
  const presentation = presentationSchema.parse(response.body);

  let remaining = MAX_CONTENT_CHARS;
  const slides = [];
  for (const [index, slide] of presentation.slides.entries()) {
    const text = slide.pageElements
      .flatMap(elementText)
      .filter(Boolean)
      .join("\n");
    const notesPage = slide.slideProperties?.notesPage;
    const notesId = notesPage?.notesProperties?.speakerNotesObjectId;
    const notesElement = notesId
      ? notesPage?.pageElements.find((element) => element.objectId === notesId)
      : undefined;
    const notes = notesElement ? elementText(notesElement).join("\n") : "";
    const size = text.length + notes.length;
    if (size > remaining) break;
    remaining -= size;
    slides.push({
      ...(notes ? { notes } : undefined),
      slide_number: index + 1,
      text,
    });
  }
  return {
    slide_count: presentation.slides.length,
    slides,
    truncated: slides.length < presentation.slides.length,
  };
}
