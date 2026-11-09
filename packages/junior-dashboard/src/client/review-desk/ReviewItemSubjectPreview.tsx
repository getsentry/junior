import type {
  OwnedObjectAnnotation,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

import { OutboundLink } from "../components/OutboundLink";
import { ObjectCard } from "../conversations/ObjectCard";
import { useConversationData } from "../conversations/queries";
import { dashboardInlineLinkClass } from "../styles";
import { reviewItemSubjectHref } from "./reviewItemFormat";

/**
 * Show the outside object that an item is about, such as a pull request. The
 * rich card is the object annotation that a plugin saved on the item's
 * Conversation for the same URL, so the inbox reads no provider. Without
 * one, it shows a plain link.
 */
export function ReviewItemSubjectPreview(props: {
  subject: NonNullable<ReviewItemPayload["subject"]>;
  conversationId: string;
}) {
  const annotations = useConversationData(props.conversationId).data
    ?.annotations;
  const { subject } = props;
  const card = annotations?.find(
    (annotation): annotation is OwnedObjectAnnotation & typeof annotation =>
      annotation.kind === "object" &&
      (annotation.url === subject.url || annotation.key === subject.id),
  );
  if (card) return <ObjectCard card={card} />;
  const href = subject.url ? reviewItemSubjectHref(subject.url) : undefined;
  return href ? (
    <OutboundLink className={dashboardInlineLinkClass} href={href}>
      {subject.title ?? subject.id}
    </OutboundLink>
  ) : null;
}
