import {
  $getRoot,
  $isElementNode,
  $isTextNode,
  mergeRegister,
  type LexicalEditor,
} from "lexical";
import { useEffect, useMemo, useState } from "react";

import { useSkillsData } from "../../api";
import { findProseSkillReferences } from "../skillReferences";

// The name of the `::highlight()` rule in `tailwind.css`.
const HIGHLIGHT_NAME = "skill-reference";

/**
 * Show each complete `$name` of an installed skill in the draft in the link
 * color of a sent skill reference. A CSS highlight paints the text, so the
 * reference stays plain text in the editor and in the DOM: typing,
 * deleting, undo, and IME input work as on any other text. Code spans and
 * fences stay plain, as in a sent message. A click only moves the caret:
 * the skill menu and the selection card open the SKILL.md.
 */
export function useSkillReferenceHighlights(editor: LexicalEditor): void {
  // Fetch the skill list only once the draft has a reference.
  const [referenced, setReferenced] = useState(false);
  const skills = useSkillsData({ enabled: referenced }).data;
  const installed = useMemo(
    () => (skills ? new Set(skills.map((skill) => skill.name)) : undefined),
    [skills],
  );

  useEffect(() => {
    if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
    const highlight = sharedHighlight();
    let painted: Range[] = [];

    // The DOM is up to date in an update listener, so ranges can point
    // into it. A caret move keeps the text nodes, and so the ranges.
    const paint = () => {
      for (const range of painted) highlight.delete(range);
      const found = editor.getEditorState().read($proseSkillReferences);
      if (found.length) setReferenced(true);
      painted = installed
        ? found.flatMap(({ name, nodeKey, start, end }) => {
            const text = editor.getElementByKey(nodeKey)?.firstChild;
            if (!installed.has(name) || !(text instanceof Text)) return [];
            const range = document.createRange();
            range.setStart(text, start);
            range.setEnd(text, end);
            return [range];
          })
        : [];
      for (const range of painted) highlight.add(range);
    };

    paint();
    return mergeRegister(
      editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
        if (dirtyElements.size > 0 || dirtyLeaves.size > 0) paint();
      }),
      () => {
        for (const range of painted) highlight.delete(range);
      },
    );
  }, [editor, installed]);
}

// Each composer adds its own ranges to one highlight of the page.
function sharedHighlight(): Highlight {
  const existing = CSS.highlights.get(HIGHLIGHT_NAME);
  if (existing) return existing;
  const highlight = new Highlight();
  CSS.highlights.set(HIGHLIGHT_NAME, highlight);
  return highlight;
}

// A reference with its text node and offsets in that node.
type NodeSkillReference = {
  name: string;
  nodeKey: string;
  start: number;
  end: number;
};

/**
 * Each prose skill reference in the draft. A name has no space, chip, or
 * line break, so a reference is in one text node.
 */
function $proseSkillReferences(): NodeSkillReference[] {
  const references = findProseSkillReferences($getRoot().getTextContent());
  if (!references.length) return [];
  // Each text node with its offset in the draft text. The draft is one
  // paragraph, as `$readComposerText` reads it.
  const nodes: { key: string; start: number; end: number }[] = [];
  let offset = 0;
  const paragraph = $getRoot().getFirstChild();
  for (const node of $isElementNode(paragraph) ? paragraph.getChildren() : []) {
    const size = node.getTextContentSize();
    if ($isTextNode(node)) {
      nodes.push({ key: node.getKey(), start: offset, end: offset + size });
    }
    offset += size;
  }
  return references.flatMap((reference) => {
    const node = nodes.find(
      ({ start, end }) => start <= reference.start && reference.end <= end,
    );
    return node
      ? [
          {
            name: reference.name,
            nodeKey: node.key,
            start: reference.start - node.start,
            end: reference.end - node.start,
          },
        ]
      : [];
  });
}
