import {
  $createTextNode,
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  BLUR_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  FOCUS_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  mergeRegister,
  type LexicalEditor,
  type NodeKey,
} from "lexical";
import { useEffect, useMemo, useRef, useState } from "react";

import type { MentionablePerson } from "@sentry/junior/api/schema";
import type {
  ComposerInsertion,
  ComposerMenuKey,
  ComposerTypeahead,
} from "../ComposerMenu";
import type { ComposerToken } from "../composerSkillToken";
import { $createComposerMentionNode } from "./ComposerMentionNode";

type CaretToken = ComposerToken & { nodeKey: NodeKey };
type TokenFinder = (text: string, caret: number) => ComposerToken | undefined;

/**
 * Follow the `$` or `@` reference at the caret of a Lexical editor, and
 * give a menu the editor side of `ComposerTypeahead`. The reference is in
 * one text node: a mention or a line break ends it.
 */
export function useLexicalTypeahead(
  editor: LexicalEditor,
  tokenAt: TokenFinder,
  onMention?: (person: MentionablePerson) => void,
): ComposerTypeahead {
  const [token, setToken] = useState<CaretToken>();
  const [textbox, setTextbox] = useState<HTMLElement | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  // Escape closes the menu until the caret leaves that reference.
  const dismissedRef = useRef<{ nodeKey: NodeKey; start: number }>(undefined);
  // A press in the menu keeps it open through the blur that it causes.
  const heldRef = useRef(false);
  const onMentionRef = useRef(onMention);
  onMentionRef.current = onMention;

  useEffect(() => {
    const sync = () => {
      const root = editor.getRootElement();
      const focused = Boolean(root?.contains(document.activeElement));
      if (!focused && heldRef.current) return;
      const next =
        focused && editor.isEditable()
          ? editor.getEditorState().read(() => $tokenAtCaret(tokenAt))
          : undefined;
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
      editor.registerUpdateListener(sync),
      editor.registerEditableListener(sync),
      editor.registerCommand(
        BLUR_COMMAND,
        () => {
          if (!heldRef.current) setToken(undefined);
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        FOCUS_COMMAND,
        () => {
          queueMicrotask(sync);
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
    );
  }, [editor, tokenAt]);

  const query = token?.query;
  return useMemo<ComposerTypeahead>(
    () => ({
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
      },
      holdOpen: (held) => {
        heldRef.current = held;
      },
      insert: (insertion) => {
        const current = tokenRef.current;
        if (!current) return;
        editor.update(() => $insertAtToken(current, insertion));
        if ("person" in insertion) onMentionRef.current?.(insertion.person);
        setToken(undefined);
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
    [editor, query, textbox],
  );
}

function $tokenAtCaret(tokenAt: TokenFinder): CaretToken | undefined {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
  const { anchor } = selection;
  if (anchor.type !== "text") return;
  const node = anchor.getNode();
  if (!$isTextNode(node)) return;
  const found = tokenAt(node.getTextContent(), anchor.offset);
  return found && { ...found, nodeKey: node.getKey() };
}

function sameToken(left: CaretToken, right: CaretToken): boolean {
  return (
    left.nodeKey === right.nodeKey &&
    left.start === right.start &&
    left.end === right.end &&
    left.query === right.query
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
  const reference = parts[token.start === 0 ? 0 : 1]!;
  const mention = $createComposerMentionNode(insertion.person);
  reference.replace(mention);
  const next = mention.getNextSibling();
  if (spaced && $isTextNode(next)) {
    next.select(1, 1);
    return;
  }
  const space = $createTextNode(" ");
  mention.insertAfter(space);
  space.select(1, 1);
}
