// oxlint-disable anti-slop/no-shape-in-symbol-names -- `shape` is a Slides API field.
/**
 * Layout checks that updateGoogleSlides runs on the slides that an edit
 * touched. The Slides API accepts edits that look broken, such as an empty
 * placeholder or text that runs past its box, so the result lists them for
 * the agent to fix.
 */
import * as z from "zod";

/** Field mask for the deck read that the checks need. */
export const SLIDE_CHECK_FIELDS =
  "pageSize,slides(objectId,pageElements(objectId,size,transform,shape(placeholder(type),text(textElements(textRun(content,style(fontSize)))))))";

const EMU_PER_PT = 12700;
// Sizes in points, for a 720 × 405 pt page.
const MIN_FONT_PT = 12;
const MAX_SLIDE_WORDS = 90;
// Google's default text box inset is 7.2 pt on each side.
const TEXT_INSET_PT = 14.4;
// Average character width and line height of a sans font, as a share of the
// font size. The overflow check is an estimate, so it reports only clear
// cases.
const CHAR_WIDTH = 0.5;
const LINE_HEIGHT = 1.2;
const OVERFLOW_MARGIN = 1.1;
const EDGE_TOLERANCE_PT = 1;
const OVERLAP_SHARE = 0.1;

const CONTENT_PLACEHOLDERS = new Set([
  "BODY",
  "CENTERED_TITLE",
  "SUBTITLE",
  "TITLE",
]);
const CHROME_PLACEHOLDERS = new Set([
  "DATE_AND_TIME",
  "FOOTER",
  "SLIDE_NUMBER",
]);

const dimensionSchema = z.object({
  magnitude: z.number().default(0),
  unit: z.string().optional(),
});

const elementSchema = z.object({
  objectId: z.string(),
  shape: z
    .object({
      placeholder: z.object({ type: z.string().optional() }).optional(),
      text: z
        .object({
          textElements: z
            .array(
              z.object({
                textRun: z
                  .object({
                    content: z.string().default(""),
                    style: z
                      .object({ fontSize: dimensionSchema.optional() })
                      .optional(),
                  })
                  .optional(),
              }),
            )
            .default([]),
        })
        .optional(),
    })
    .optional(),
  size: z
    .object({ height: dimensionSchema, width: dimensionSchema })
    .optional(),
  transform: z
    .object({
      scaleX: z.number().default(0),
      scaleY: z.number().default(0),
      shearX: z.number().default(0),
      shearY: z.number().default(0),
      translateX: z.number().default(0),
      translateY: z.number().default(0),
      unit: z.string().optional(),
    })
    .optional(),
});

const deckSchema = z.object({
  pageSize: z
    .object({ height: dimensionSchema, width: dimensionSchema })
    .optional(),
  slides: z
    .array(
      z.object({
        objectId: z.string(),
        pageElements: z.array(elementSchema).default([]),
      }),
    )
    .default([]),
});

type Element = z.infer<typeof elementSchema>;

/** One problem on a slide, in words that say what to fix. */
export interface SlideIssue {
  element_id?: string;
  problem: string;
  slide_id: string;
}

interface Box {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

function points(value: number, unit: string | undefined): number {
  return unit === "PT" ? value : value / EMU_PER_PT;
}

/** Return the rendered box of an element in points, or nothing when rotated. */
function elementBox(element: Element): Box | undefined {
  const { size, transform } = element;
  if (!size || !transform || transform.shearX || transform.shearY) {
    return undefined;
  }
  const left = points(transform.translateX, transform.unit);
  const top = points(transform.translateY, transform.unit);
  // A negative scale flips the element, so it extends left or up from its
  // translation.
  const right =
    left + points(size.width.magnitude, size.width.unit) * transform.scaleX;
  const bottom =
    top + points(size.height.magnitude, size.height.unit) * transform.scaleY;
  return {
    bottom: Math.max(top, bottom),
    left: Math.min(left, right),
    right: Math.max(left, right),
    top: Math.min(top, bottom),
  };
}

function elementText(element: Element): string {
  return (element.shape?.text?.textElements ?? [])
    .map((item) => item.textRun?.content ?? "")
    .join("");
}

/** Return the largest font size that the text sets on every run, if any. */
function explicitFontSize(element: Element): number | undefined {
  let largest = 0;
  for (const item of element.shape?.text?.textElements ?? []) {
    const run = item.textRun;
    if (!run?.content.trim()) continue;
    const size = run.style?.fontSize;
    if (!size) return undefined;
    largest = Math.max(largest, points(size.magnitude, size.unit));
  }
  return largest || undefined;
}

function smallestFontSize(element: Element): number | undefined {
  const sizes = (element.shape?.text?.textElements ?? []).flatMap((item) => {
    const size = item.textRun?.style?.fontSize;
    return item.textRun?.content.trim() && size
      ? [points(size.magnitude, size.unit)]
      : [];
  });
  return sizes.length ? Math.min(...sizes) : undefined;
}

/** Estimate whether the text needs more height than its box has. */
function mayOverflow(text: string, fontSize: number, box: Box): boolean {
  const width = box.right - box.left - TEXT_INSET_PT;
  const height = box.bottom - box.top;
  if (width <= 0) return true;
  const perLine = Math.max(1, Math.floor(width / (CHAR_WIDTH * fontSize)));
  const lines = text
    .replace(/\n$/, "")
    .split("\n")
    .reduce(
      (sum, paragraph) =>
        sum + Math.max(1, Math.ceil(paragraph.length / perLine)),
      0,
    );
  // One line spills past a short box without hiding text, such as a label.
  if (lines < 2) return false;
  const needed = lines * LINE_HEIGHT * fontSize + TEXT_INSET_PT;
  return needed > height * OVERFLOW_MARGIN;
}

function overlapShare(a: Box, b: Box): number {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (width <= 0 || height <= 0) return 0;
  const area = (box: Box) => (box.right - box.left) * (box.bottom - box.top);
  return (width * height) / Math.min(area(a), area(b));
}

/** Collect every object id that a request or reply names. */
function namedIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) namedIds(item, ids);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const entries: Array<[string, unknown]> = Object.entries(value);
  for (const [key, item] of entries) {
    if (typeof item === "string" && /^(objectId|pageObjectId)$/.test(key)) {
      ids.add(item);
    } else if (key === "objectIds" && typeof item === "object" && item) {
      for (const id of Object.values(item)) {
        if (typeof id === "string") ids.add(id);
      }
    } else if (
      /^(pageObjectIds|slideObjectIds|pageElementObjectIds)$/.test(key) &&
      Array.isArray(item)
    ) {
      for (const id of item) if (typeof id === "string") ids.add(id);
    } else {
      namedIds(item, ids);
    }
  }
}

function slideProblems(
  elements: Element[],
  page: Box | undefined,
): Array<Omit<SlideIssue, "slide_id">> {
  const problems: Array<Omit<SlideIssue, "slide_id">> = [];
  const texts: Array<{ box: Box; id: string }> = [];
  let words = 0;
  for (const element of elements) {
    const placeholder = element.shape?.placeholder?.type;
    const text = elementText(element);
    const box = elementBox(element);
    const id = element.objectId;
    if (!text.trim()) {
      if (placeholder && CONTENT_PLACEHOLDERS.has(placeholder)) {
        problems.push({
          element_id: id,
          problem: `Empty ${placeholder} placeholder. Fill it or delete it.`,
        });
      }
      continue;
    }
    if (placeholder && CHROME_PLACEHOLDERS.has(placeholder)) continue;
    words += text.split(/\s+/).filter(Boolean).length;
    const smallest = smallestFontSize(element);
    if (smallest !== undefined && smallest < MIN_FONT_PT) {
      problems.push({
        element_id: id,
        problem: `Text is ${smallest} pt. Use at least ${MIN_FONT_PT} pt: cut words or split the slide.`,
      });
    }
    if (!box) continue;
    texts.push({ box, id });
    if (
      page &&
      (box.left < -EDGE_TOLERANCE_PT ||
        box.top < -EDGE_TOLERANCE_PT ||
        box.right > page.right + EDGE_TOLERANCE_PT ||
        box.bottom > page.bottom + EDGE_TOLERANCE_PT)
    ) {
      problems.push({
        element_id: id,
        problem: "Text box goes past the edge of the slide.",
      });
    }
    const fontSize = explicitFontSize(element);
    if (fontSize && mayOverflow(text, fontSize, box)) {
      problems.push({
        element_id: id,
        problem: `Text probably needs more height than its box has at ${fontSize} pt. Cut words, widen or heighten the box, or split the slide.`,
      });
    }
  }
  for (const [index, a] of texts.entries()) {
    for (const b of texts.slice(index + 1)) {
      if (overlapShare(a.box, b.box) > OVERLAP_SHARE) {
        problems.push({
          element_id: a.id,
          problem: `Text overlaps the text of ${b.id}.`,
        });
      }
    }
  }
  if (words > MAX_SLIDE_WORDS) {
    problems.push({
      problem: `The slide has ${words} words. Keep it under ${MAX_SLIDE_WORDS}: split it, or move detail to the speaker notes.`,
    });
  }
  return problems;
}

/**
 * Check the slides that an edit touched. A slide is touched when a request
 * or reply names the slide or one of its elements.
 */
export function checkTouchedSlides(
  deck: unknown,
  requests: unknown[],
  replies: unknown[],
): { changed_slides: string[]; issues: SlideIssue[] } {
  const parsed = deckSchema.parse(deck);
  const ids = new Set<string>();
  namedIds(requests, ids);
  namedIds(replies, ids);
  const page = parsed.pageSize && {
    bottom: points(
      parsed.pageSize.height.magnitude,
      parsed.pageSize.height.unit,
    ),
    left: 0,
    right: points(parsed.pageSize.width.magnitude, parsed.pageSize.width.unit),
    top: 0,
  };
  const touched = parsed.slides.filter(
    (slide) =>
      ids.has(slide.objectId) ||
      slide.pageElements.some((element) => ids.has(element.objectId)),
  );
  return {
    changed_slides: touched.map((slide) => slide.objectId),
    issues: touched.flatMap((slide) =>
      slideProblems(slide.pageElements, page).map((problem) => ({
        slide_id: slide.objectId,
        ...problem,
      })),
    ),
  };
}
