import type { InboxItemPayload } from "@sentry/junior/api/schema";

import { displayPlainText } from "../display-text/plainText";
import type { CodeChangeHead } from "../inbox/codeChangeHead";
import { inboxItemTitleText } from "../inbox/inboxItemFormat";

/**
 * The title of a Needs you item. A code change leads with its state in one
 * word, such as "Review", then the change's title, as its Inbox row does.
 */
export function NeedsYouTitle(props: {
  head: CodeChangeHead | undefined;
  item: InboxItemPayload;
}) {
  const { head } = props;
  return (
    <>
      {head ? (
        <span
          className="relative -top-px mr-1.5 inline-flex h-4.5 items-center rounded border border-dashboard-border px-1 align-middle text-xs font-medium leading-none text-dashboard-text-muted"
          title={head.kind}
        >
          {head.state}
        </span>
      ) : null}
      <span className="font-semibold">
        {head
          ? displayPlainText(head.title.text)
          : inboxItemTitleText(props.item)}
      </span>
    </>
  );
}
