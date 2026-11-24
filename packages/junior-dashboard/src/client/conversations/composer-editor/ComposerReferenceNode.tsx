import {
  $applyNodeReplacement,
  DecoratorNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import type { ReactNode } from "react";

import { ComposerReferenceChip } from "../ComposerReference";
import { referenceText, type ComposerReference } from "../composerReferences";

type SerializedComposerReference = Spread<
  { reference: ComposerReference },
  SerializedLexicalNode
>;

/**
 * One referenced Conversation, Task, file, pull request, or channel in the
 * composer. It shows a chip, and its text is the token of `referenceText`,
 * so the Message has the link or channel that the transcript renders.
 */
export class ComposerReferenceNode extends DecoratorNode<ReactNode> {
  __reference: ComposerReference;

  static override getType(): string {
    return "composer-reference";
  }

  static override clone(node: ComposerReferenceNode): ComposerReferenceNode {
    return new ComposerReferenceNode(node.__reference, node.__key);
  }

  static override importJSON(
    json: SerializedComposerReference,
  ): ComposerReferenceNode {
    return $createComposerReferenceNode(json.reference);
  }

  constructor(reference: ComposerReference, key?: NodeKey) {
    super(key);
    this.__reference = reference;
  }

  override exportJSON(): SerializedComposerReference {
    return { ...super.exportJSON(), reference: this.__reference };
  }

  override createDOM(): HTMLElement {
    return document.createElement("span");
  }

  override updateDOM(): false {
    return false;
  }

  override isInline(): true {
    return true;
  }

  override getTextContent(): string {
    return referenceText(this.__reference);
  }

  override decorate(): ReactNode {
    return <ComposerReferenceChip reference={this.__reference} />;
  }
}

/** Create a chip node for one reference. */
export function $createComposerReferenceNode(
  reference: ComposerReference,
): ComposerReferenceNode {
  return $applyNodeReplacement(new ComposerReferenceNode(reference));
}
