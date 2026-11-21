import {
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  BLUR_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  FOCUS_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  mergeRegister,
  type LexicalEditor,
  type NodeKey,
} from "lexical";
import { useEffect, useMemo, useRef, useState } from "react";

import { isPlatformShortcut } from "../../keyboard";
import type {
  ComposerInsertion,
  ComposerMenuKey,
  ComposerTypeahead,
} from "../ComposerMenu";
import type { ComposerToken } from "../composerSkillToken";
import { $createComposerMentionNode } from "./ComposerMentionNode";
import { $createComposerReferenceNode } from "./ComposerReferenceNode";

type CaretToken = ComposerToken & {
  edited: boolean;
  name: string;
  nodeKey: NodeKey;
};
type TokenFinder = (text: string, caret: number) => ComposerToken | undefined;
// Where a reference is: its text node and offsets.
type TextRange = { nodeKey: NodeKey; start: number; end: number };
// The text and a collapsed caret that the last sync read.
type Synced = { text: string; caret: string };

// Tags the update of an insert, so its sync keeps `inserted`.
const INSERT_TAG = "composer-typeahead-insert";

/**
 * Follow the `$`, `@`, or `#` reference at the caret of a Lexical editor,
 * and give a menu the editor side of `ComposerTypeahead`. The reference is
 * in one text node: a chip or a line break ends it. `onChip` hears each
 * person or reference that an insert puts in.
 */
export function useLexicalTypeahead(
  editor: LexicalEditor,
  tokenAt: TokenFinder,
  onChip?: (insertion: ComposerInsertion) => void,
): ComposerTypeahead {
  const [token, setToken] = useState<CaretToken>();
  const [inserted, setInserted] = useState<string>();
  // Where the last text insert went, while `inserted` holds it.
  const insertedRangeRef = useRef<TextRange>(undefined);
  const [textbox, setTextbox] = useState<HTMLElement | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  // Escape closes the menu until the caret leaves that reference.
  const dismissedRef = useRef<{ nodeKey: NodeKey; start: number }>(undefined);
  // A press in the menu keeps it open through the blur that it causes.
  const heldRef = useRef(false);
  const clearInserted = () => {
    insertedRangeRef.current = undefined;
    setInserted(undefined);
  };
  const onChipRef = useRef(onChip);
  onChipRef.current = onChip;

  // A sync that reads the same text and caret changes nothing. Focus and
  // a repeat selection event must not turn an edit into a caret move.
  const syncedRef = useRef<Synced>(undefined);

  useEffect(() => {
    const sync = () => {
      const root = editor.getRootElement();
      const focused = Boolean(root?.contains(document.activeElement));
      if (!focused && heldRef.current) return;
      const read =
        focused && editor.isEditable()
          ? editor.getEditorState().read($readCaret)
          : undefined;
      if (!read) {
        // A collapse back to the same caret, or a focus, reads it again.
        syncedRef.current = undefined;
        setToken(undefined);
        clearInserted();
        return;
      }
      const last = syncedRef.current;
      if (last?.text === read.text && last.caret === read.caret) return;
      syncedRef.current = read;
      clearInserted();
      const found = editor.getEditorState().read(() => $tokenAtCaret(tokenAt));
      const next = found && {
        ...found,
        edited: last !== undefined && last.text !== read.text,
      };
      const dismissed = dismissedRef.current;
      if (
        dismissed &&
        (next?.nodeKey !== dismissed.nodeKey || next.start !== dismissed.start)
      ) {
        dismissedRef.current = undefined;
      }
      setToken((current) =>
        !next || dismissedRef.current
          ? undefined
          : current && sameToken(current, next)
            ? current
            : next,
      );
    };
    return mergeRegister(
      editor.registerRootListener((root) => setTextbox(root)),
      editor.registerUpdateListener(({ editorState, tags }) => {
        if (!tags.has(INSERT_TAG)) {
          sync();
          return;
        }
        // An insert keeps `inserted`, also when a tap in the menu blurred
        // the text box. The caret is now after the reference.
        syncedRef.current = editorState.read($readCaret);
        setToken(undefined);
      }),
      editor.registerEditableListener(() => sync()),
      editor.registerCommand(
        BLUR_COMMAND,
        () => {
          if (heldRef.current) return false;
          syncedRef.current = undefined;
          setToken(undefined);
          clearInserted();
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        FOCUS_COMMAND,
        () => {
          queueMicrotask(() => sync());
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
    );
  }, [editor, tokenAt]);

  const query = token?.query;
  const name = token?.name;
  const edited = token?.edited ?? false;
  return useMemo<ComposerTypeahead>(
    () => ({
      edited,
      inserted,
      name,
      query,
      textbox,
      dismiss: () => {
        const current = tokenRef.current;
        if (current) {
          dismissedRef.current = {
            nodeKey: current.nodeKey,
            start: current.start,
          };
        }
        setToken(undefined);
        clearInserted();
      },
      focus: () => editor.focus(),
      referenceRect: () => {
        const range = insertedRangeRef.current ?? token;
        return range && textRangeRect(editor, range);
      },
      holdOpen: (held) => {
        heldRef.current = held;
      },
      insert: (insertion) => {
        const current = tokenRef.current;
        if (!current) return;
        if ("text" in insertion) {
          setInserted(insertion.text);
          insertedRangeRef.current = {
            nodeKey: current.nodeKey,
            start: current.start,
            end: current.start + insertion.text.length,
          };
        } else {
          clearInserted();
          // Before the update, so the change it reports knows the chip.
          onChipRef.current?.(insertion);
        }
        editor.update(() => $insertAtToken(current, insertion), {
          tag: INSERT_TAG,
        });
      },
      registerKeys: (handler) => {
        const take = (event: KeyboardEvent | null, key: ComposerMenuKey) => {
          if (event?.isComposing || !handler(key)) return false;
          event?.preventDefault();
          event?.stopPropagation();
          return true;
        };
        const select = (event: KeyboardEvent | null) =>
          !event?.shiftKey && take(event, "select");
        return mergeRegister(
          editor.registerCommand(
            KEY_DOWN_COMMAND,
            (event) => isPlatformShortcut(event, "i") && take(event, "view"),
            COMMAND_PRIORITY_HIGH,
          ),
          editor.registerCommand(
            KEY_ARROW_DOWN_COMMAND,
            (event) => take(event, "down"),
            COMMAND_PRIORITY_HIGH,
          ),
          editor.registerCommand(
            KEY_ARROW_UP_COMMAND,
            (event) => take(event, "up"),
            COMMAND_PRIORITY_HIGH,
          ),
          editor.registerCommand(
            KEY_ENTER_COMMAND,
            select,
            COMMAND_PRIORITY_HIGH,
          ),
          editor.registerCommand(
            KEY_TAB_COMMAND,
            select,
            COMMAND_PRIORITY_HIGH,
          ),
          editor.registerCommand(
            KEY_ESCAPE_COMMAND,
            (event) => take(event, "close"),
            COMMAND_PRIORITY_HIGH,
          ),
        );
      },
    }),
    [edited, editor, inserted, name, query, textbox, token],
  );
}

/** The screen box of a reference, or of its first line when it wraps. */
function textRangeRect(
  editor: LexicalEditor,
  range: TextRange,
): DOMRect | undefined {
  const text = editor.getElementByKey(range.nodeKey)?.firstChild;
  if (!(text instanceof Text)) return;
  const end = Math.min(range.end, text.length);
  const dom = document.createRange();
  dom.setStart(text, Math.min(range.start, end));
  dom.setEnd(text, end);
  return dom.getClientRects()[0] ?? dom.getBoundingClientRect();
}

/** The text and the collapsed caret, or nothing for a range selection. */
function $readCaret(): Synced | undefined {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
  const { anchor } = selection;
  return {
    text: $getRoot().getTextContent(),
    caret: `${anchor.key}:${anchor.offset}`,
  };
}

function $tokenAtCaret(
  tokenAt: TokenFinder,
): Omit<CaretToken, "edited"> | undefined {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
  const { anchor } = selection;
  if (anchor.type !== "text") return;
  const node = anchor.getNode();
  if (!$isTextNode(node)) return;
  const text = node.getTextContent();
  const found = tokenAt(text, anchor.offset);
  return (
    found && {
      ...found,
      name: text.slice(found.start + 1, found.end),
      nodeKey: node.getKey(),
    }
  );
}

function sameToken(left: CaretToken, right: CaretToken): boolean {
  return (
    left.nodeKey === right.nodeKey &&
    left.start === right.start &&
    left.end === right.end &&
    left.query === right.query &&
    left.edited === right.edited
  );
}

/** Replace the reference and put the caret after one space. */
function $insertAtToken(token: CaretToken, insertion: ComposerInsertion) {
  const node = $getNodeByKey(token.nodeKey);
  if (!$isTextNode(node)) return;
  // Reuse a space that already follows the reference.
  const spaced = /^\s/.test(node.getTextContent().slice(token.end));
  if ("text" in insertion) {
    const text = `${insertion.text}${spaced ? "" : " "}`;
    node.spliceText(token.start, token.end - token.start, text);
    const caret = token.start + insertion.text.length + 1;
    node.select(caret, caret);
    return;
  }
  const parts = node.splitText(token.start, token.end);
  const typed = parts[token.start === 0 ? 0 : 1]!;
  const chip =
    "person" in insertion
      ? $createComposerMentionNode(insertion.person)
      : $createComposerReferenceNode(insertion.reference);
  typed.replace(chip);
  const next = chip.getNextSibling();
  if (spaced && $isTextNode(next)) {
    next.select(1, 1);
    return;
  }
  const space = $createTextNode(" ");
  chip.insertAfter(space);
  space.select(1, 1);
}
