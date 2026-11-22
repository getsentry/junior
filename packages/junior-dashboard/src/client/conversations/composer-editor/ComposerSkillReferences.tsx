import {
  $getRoot,
  $isElementNode,
  $isTextNode,
  mergeRegister,
  type LexicalEditor,
} from "lexical";
import { useEffect, useMemo, useState } from "react";

import { useSkillsData } from "../../api";
import { SkillDrawer } from "../../components/SkillLink";
import { findProseSkillReferences } from "../skillReferences";

// The names of the `::highlight()` rules in `tailwind.css`.
const LINK_HIGHLIGHT = "skill-reference";
const HOVER_HIGHLIGHT = "skill-reference-hover";

type SkillReferenceRange = { name: string; range: Range };

/**
 * Show each complete `$name` of an installed skill in the draft as a skill
 * link, and open its SKILL.md on a mouse click. A CSS highlight paints the
 * text, so the reference stays plain text in the editor and in the DOM:
 * typing, deleting, undo, and IME input work as on any other text. Code
 * spans and fences stay text, as in a sent message. A tap only puts the
 * caret, so touch screens keep their caret behavior.
 */
export function ComposerSkillReferences(props: { editor: LexicalEditor }) {
  const { editor } = props;
  // Fetch the skill list only once the draft has a reference.
  const [referenced, setReferenced] = useState(false);
  const skills = useSkillsData({ enabled: referenced }).data;
  const installed = useMemo(
    () => (skills ? new Set(skills.map((skill) => skill.name)) : undefined),
    [skills],
  );
  const [viewing, setViewing] = useState<string>();

  useEffect(() => {
    if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
    const links = sharedHighlight(LINK_HIGHLIGHT);
    const hover = sharedHighlight(HOVER_HIGHLIGHT);
    let painted: SkillReferenceRange[] = [];
    let hovered: SkillReferenceRange | undefined;
    // The pointer that pressed last. Only a mouse click opens the drawer.
    let pointerType = "";

    const setHovered = (next: SkillReferenceRange | undefined) => {
      if (next === hovered) return;
      if (hovered) hover.delete(hovered.range);
      if (next) hover.add(next.range);
      hovered = next;
      const root = editor.getRootElement();
      if (next) root?.setAttribute("data-skill-hover", "");
      else root?.removeAttribute("data-skill-hover");
    };

    // The DOM is up to date in an update listener, so ranges can point
    // into it. A caret move keeps the text nodes, and so the ranges.
    const paint = () => {
      setHovered(undefined);
      for (const { range } of painted) links.delete(range);
      const found = editor.getEditorState().read($proseSkillReferences);
      if (found.length) setReferenced(true);
      painted = installed
        ? found.flatMap(({ name, nodeKey, start, end }) => {
            const text = editor.getElementByKey(nodeKey)?.firstChild;
            if (!installed.has(name) || !(text instanceof Text)) return [];
            const range = document.createRange();
            range.setStart(text, start);
            range.setEnd(text, end);
            return [{ name, range }];
          })
        : [];
      for (const { range } of painted) links.add(range);
    };

    const at = (event: MouseEvent) =>
      painted.find(({ range }) =>
        [...range.getClientRects()].some(
          (rect) =>
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom,
        ),
      );
    const onPointerDown = (event: PointerEvent) => {
      pointerType = event.pointerType;
    };
    const onMouseMove = (event: MouseEvent) => setHovered(at(event));
    const onMouseLeave = () => setHovered(undefined);
    // After the browser put the caret, so a click edits as it always does
    // and the drawer gives the caret back when it closes. A drag, a
    // modified click, or a double click selects text instead.
    const onClick = (event: MouseEvent) => {
      if (
        pointerType !== "mouse" ||
        event.button !== 0 ||
        event.detail > 1 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        !window.getSelection()?.isCollapsed
      ) {
        return;
      }
      const reference = at(event);
      if (reference) setViewing(reference.name);
    };

    paint();
    return mergeRegister(
      editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
        if (dirtyElements.size > 0 || dirtyLeaves.size > 0) paint();
      }),
      editor.registerRootListener((root, previous) => {
        previous?.removeEventListener("pointerdown", onPointerDown);
        previous?.removeEventListener("mousemove", onMouseMove);
        previous?.removeEventListener("mouseleave", onMouseLeave);
        previous?.removeEventListener("click", onClick);
        root?.addEventListener("pointerdown", onPointerDown);
        root?.addEventListener("mousemove", onMouseMove);
        root?.addEventListener("mouseleave", onMouseLeave);
        root?.addEventListener("click", onClick);
      }),
      () => {
        setHovered(undefined);
        for (const { range } of painted) links.delete(range);
      },
    );
  }, [editor, installed]);

  return viewing ? (
    <SkillDrawer
      name={viewing}
      onClose={() => {
        setViewing(undefined);
        editor.focus();
      }}
    />
  ) : null;
}

// Each composer adds its own ranges to one highlight of the page.
function sharedHighlight(name: string): Highlight {
  const existing = CSS.highlights.get(name);
  if (existing) return existing;
  const highlight = new Highlight();
  CSS.highlights.set(name, highlight);
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
