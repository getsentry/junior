import fs from "node:fs";
import path from "node:path";
import { CONSTRUCTS, SURFACES } from "./reply-rendering-constructs.mjs";

/**
 * Reply rendering check. A construct that reply content can hold must render
 * on every surface that shows replies, natively or with a fallback that
 * keeps its content (getsentry/junior#4236).
 * `scripts/reply-rendering-constructs.mjs` lists each construct and how
 * each surface renders it.
 *
 * - Each construct has one entry per surface. An `unsupported` entry fails.
 * - Each entry points at its renderer code: `marker` must be in `file`.
 * - `HANDLERS` reads the constructs that some renderers list. Each name must
 *   belong to a construct, so a construct cannot ship on one surface only.
 */

const REGISTRY = "scripts/reply-rendering-constructs.mjs";
const HOW = new Set(["native", "fallback", "unsupported"]);

/**
 * Renderer code that lists the constructs that a surface handles. `block`
 * starts the part of the file to read. It ends at the `}` or `};` line with
 * the same indent. `name` matches each construct name in it.
 */
export const HANDLERS = [
  {
    surface: "dashboard",
    file: "packages/junior-dashboard/src/client/display-text/markdown.tsx",
    block: "const COMPONENTS: Components = {",
    name: /^ {2}(\w+):/gm,
  },
  {
    surface: "dashboard",
    file: "packages/junior-dashboard/src/client/conversations/TranscriptMessageView.tsx",
    block: "switch (card.kind) {",
    name: /case "(\w+)":/g,
    prefix: "card:",
  },
  {
    surface: "slack",
    file: "packages/junior/src/chat/slack/cards.ts",
    block: "export function renderSlackCard(",
    name: /case "(\w+)":/g,
    prefix: "card:",
  },
  {
    surface: "ios",
    file: "apps/ios/Packages/JuniorKit/Sources/JuniorKit/Markdown/MarkdownBlocks.swift",
    block: "public indirect enum MarkdownBlock",
    name: /^ {2}case (\w+)/gm,
  },
];

/** Return the names that one handler finds, or undefined without its block. */
export function handledNames(source, handler) {
  const start = source.indexOf(handler.block);
  if (start === -1) return undefined;
  const lineStart = source.lastIndexOf("\n", start) + 1;
  const indent = source.slice(lineStart, start).replace(/\S.*/, "");
  const end = source.indexOf(`\n${indent}}`, start);
  const block = source.slice(start, end === -1 ? undefined : end);
  return [...block.matchAll(handler.name)].map(
    (match) => `${handler.prefix ?? ""}${match[1]}`,
  );
}

function describe(id, surface, support) {
  return `${id} on ${surface} (${support.file})`;
}

/**
 * Report the problems of a registry. `read(file)` returns the text of a repo
 * file, or undefined when it does not exist.
 */
export function checkRegistry({ constructs, surfaces, handlers, read }) {
  const errors = [];
  const claimed = new Map();
  for (const { id, support } of constructs) {
    for (const surface of Object.keys(surfaces)) {
      const entry = support[surface];
      if (!entry) {
        errors.push(`${id} has no entry for ${surface} in ${REGISTRY}.`);
        continue;
      }
      if (!HOW.has(entry.how) || (entry.how !== "native" && !entry.note)) {
        errors.push(
          `${describe(id, surface, entry)}: set how to native, or to fallback or unsupported with a note.`,
        );
      }
      if (!read(entry.file)?.includes(entry.marker)) {
        errors.push(
          `${describe(id, surface, entry)}: the file does not contain "${entry.marker}". Point the entry at the renderer code.`,
        );
      }
      if (entry.how === "unsupported") {
        errors.push(
          `${describe(id, surface, entry)} is unsupported: ${entry.note}. Render it there, natively or with a fallback that keeps its content, then update ${REGISTRY}.`,
        );
      }
      for (const name of entry.handles ?? []) {
        claimed.set(`${surface}:${name}`, { id, name, surface });
      }
    }
  }

  const found = new Set();
  for (const handler of handlers) {
    const names = handledNames(read(handler.file) ?? "", handler);
    if (!names) {
      errors.push(
        `${handler.file} no longer contains "${handler.block}". Update HANDLERS in scripts/check-reply-rendering.mjs.`,
      );
      continue;
    }
    for (const name of names) {
      const key = `${handler.surface}:${name}`;
      found.add(key);
      if (!claimed.has(key)) {
        errors.push(
          `${handler.file} renders "${name}" on ${handler.surface}, which no construct in ${REGISTRY} handles. Add it to a construct, with an entry for every surface.`,
        );
      }
    }
  }
  const listedSurfaces = new Set(handlers.map((handler) => handler.surface));
  for (const [key, { id, name, surface }] of claimed) {
    if (listedSurfaces.has(surface) && !found.has(key)) {
      errors.push(
        `${id} handles "${name}" on ${surface}, which no renderer in HANDLERS lists.`,
      );
    }
  }
  return errors;
}

/** Check the registry against the repo. */
export function run({ root }) {
  const read = (file) => {
    const full = path.join(root, file);
    return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : undefined;
  };
  return checkRegistry({
    constructs: CONSTRUCTS,
    surfaces: SURFACES,
    handlers: HANDLERS,
    read,
  });
}
