import { ChevronRight } from "lucide-react";
import type {
  ReviewItemActionBody,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { ClampedDisplayText } from "../display-text/DisplayText";
import { dashboardDisclosureChevronClass } from "../styles";
import { AskKindIcon } from "./askKind";
import { foldedNoticeLabel } from "./inboxModel";
import { ReviewItemActions } from "./ReviewItemActions";
import { ReviewItemObjects } from "./ReviewItemObjects";
import { itemConversationId, reviewItemText } from "./reviewItemFormat";

/**
 * A notice about the item's subject, as one quiet line in the item's card.
 * It opens to the notice's text and its own Dismiss. `onAction` takes the
 * Dismiss in place of its own action, as `ReviewItemActions` says.
 */
export function FoldedNotice(props: {
  notice: ReviewItemPayload;
  onAction?(body: ReviewItemActionBody): Promise<void>;
}) {
  const { notice } = props;
  return (
    <Collapsible
      aria-label={notice.title}
      className="min-w-0 text-dashboard-text-muted"
      data-folded-notice=""
      render={<section />}
    >
      <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1.5 rounded-md text-sm focus-visible:outline-2 focus-visible:outline-dashboard-focus">
        <AskKindIcon kind="FYI" />
        {foldedNoticeLabel(notice)}
        <ChevronRight
          aria-hidden="true"
          className={dashboardDisclosureChevronClass}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="grid min-w-0 gap-2 pt-2 pl-5">
        <ReviewItemObjects conversationId={itemConversationId(notice)}>
          <ClampedDisplayText
            className="max-w-[80ch] leading-6"
            label={notice.title}
            lines={4}
            mentions={notice.mentions}
            text={reviewItemText(notice)}
          />
        </ReviewItemObjects>
        <ReviewItemActions item={notice} onAction={props.onAction} />
      </CollapsibleContent>
    </Collapsible>
  );
}
