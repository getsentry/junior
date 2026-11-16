import { useRef } from "react";

import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerTitle,
} from "../components/ui/drawer";
import { useSheet } from "../components/ui/useSheet";
import { cn } from "../styles";
import type { ConversationMenuItem } from "./conversationMenuItems";
import {
  useConversationRowMenuGroups,
  type ConversationRowMenuProps,
} from "./ConversationRowMenu";

const ROW_CLASS =
  "flex min-h-12 w-full cursor-pointer items-center gap-3 px-4 text-left font-sans text-base text-dashboard-text no-underline transition-colors active:bg-dashboard-fill-soft disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-dashboard-text-muted";
// Rows sit in a group, which owns the border and the fill.
const PLAIN_ROW_CLASS = cn(ROW_CLASS, "border-0 bg-transparent");
const GROUP_CLASS =
  "overflow-hidden rounded-xl border border-dashboard-border-subtle bg-dashboard-fill-faint";

/**
 * Show the row menu as a bottom sheet for a long press on a touch screen.
 * It opens away from the finger, and a swipe down closes it.
 */
export function ConversationRowSheet(
  props: ConversationRowMenuProps & { onClose(): void; title: string },
) {
  const { onClose, title, ...menu } = props;
  const groups = useConversationRowMenuGroups(menu);
  // Focus the list, not its first row, so a touch open shows no focus ring.
  const listRef = useRef<HTMLDivElement>(null);
  const sheet = useSheet(onClose, listRef);
  // Close with the exit animation. `useSheet` calls `onClose` after it.
  const close = () => sheet.rootProps.onOpenChange(false, { cancel() {} });
  return (
    <Drawer {...sheet.rootProps}>
      <DrawerContent
        {...sheet.contentProps}
        className="mx-auto w-full max-w-lg pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        data-dashboard-modal=""
      >
        <div
          aria-hidden="true"
          className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-dashboard-border-strong"
        />
        <DrawerTitle className="m-0 truncate px-5 pt-3 pb-2 text-center font-sans text-sm font-medium text-dashboard-text-muted">
          {title}
        </DrawerTitle>
        <div
          className="grid min-h-0 gap-2 overflow-y-auto overscroll-contain px-3 outline-none"
          ref={listRef}
          tabIndex={-1}
        >
          {groups.map((items, index) => (
            <ul
              className={cn(
                GROUP_CLASS,
                "m-0 list-none divide-y divide-dashboard-border-subtle p-0",
              )}
              key={index}
            >
              {items.map((item) => (
                <li key={item.key}>
                  <SheetRow item={item} onClose={close} />
                </li>
              ))}
            </ul>
          ))}
          <DrawerClose
            className={cn(ROW_CLASS, GROUP_CLASS, "justify-center font-medium")}
          >
            Cancel
          </DrawerClose>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function SheetRow(props: { item: ConversationMenuItem; onClose(): void }) {
  const { item } = props;
  if (item.href) {
    return (
      <a
        className={PLAIN_ROW_CLASS}
        href={item.href}
        onClick={props.onClose}
        rel="noreferrer"
        target="_blank"
      >
        <item.icon aria-hidden="true" />
        {item.label}
      </a>
    );
  }
  return (
    <>
      <button
        className={PLAIN_ROW_CLASS}
        disabled={item.disabled}
        onClick={() => {
          item.onClick?.();
          // Share and copy show their result in the label, so they stay.
          if (!item.stayOpen) props.onClose();
        }}
        type="button"
      >
        <item.icon aria-hidden="true" />
        {item.label}
      </button>
      {item.feedback === undefined ? null : (
        <span className="sr-only" role="status">
          {item.feedback}
        </span>
      )}
    </>
  );
}
