import {
  $applyNodeReplacement,
  DecoratorNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import type { ReactNode } from "react";

import type { MentionablePerson } from "@sentry/junior/api/schema";
import { ComposerMention } from "../ComposerMention";
import { mentionText } from "../composerMentionToken";

/** A mentioned person. Only the Slack id is known for a mention read back from text. */
export type ComposerMentionPerson = Partial<MentionablePerson> & {
  slackUserId: string;
};

type SerializedComposerMention = Spread<
  { person: ComposerMentionPerson },
  SerializedLexicalNode
>;

/**
 * One mentioned person in the composer. It shows a photo and a name, and
 * its text is `<@U…>`, so the Message has the token that core reads.
 */
export class ComposerMentionNode extends DecoratorNode<ReactNode> {
  __person: ComposerMentionPerson;

  static override getType(): string {
    return "composer-mention";
  }

  static override clone(node: ComposerMentionNode): ComposerMentionNode {
    return new ComposerMentionNode(node.__person, node.__key);
  }

  static override importJSON(
    json: SerializedComposerMention,
  ): ComposerMentionNode {
    return $createComposerMentionNode(json.person);
  }

  constructor(person: ComposerMentionPerson, key?: NodeKey) {
    super(key);
    this.__person = person;
  }

  override exportJSON(): SerializedComposerMention {
    return { ...super.exportJSON(), person: this.__person };
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
    return mentionText(this.__person.slackUserId);
  }

  override decorate(): ReactNode {
    return <ComposerMention person={this.__person} />;
  }
}

/** Create a mention node for one person. */
export function $createComposerMentionNode(
  person: ComposerMentionPerson,
): ComposerMentionNode {
  return $applyNodeReplacement(new ComposerMentionNode(person));
}
