import type { ReactNode } from "react";

import {
  MobileHeaderActionsPortal,
  MobileHeaderTitlePortal,
} from "../../../components/layout/DashboardChrome";
import { HeaderBar } from "../../../components/layout/HeaderBar";
import { PageLayout } from "../../../components/layout/PageLayout";
import { useSidebarFits } from "../../../conversations/conversationSidebarLayout";
import { useDocumentTitle } from "../../../documentTitle";
import { useInboxReturnHere } from "../../../inbox/inboxListState";
import { fadeOverflowClass, fadeWhenOverflowing } from "../../../textFade";
import { cn } from "../../../styles";

/**
 * The frame of a Code page, as an Inbox list has it. On a desktop a header
 * bar holds the way back, the title, and the page's tabs. On a phone the
 * tabs go in the phone header, which has the way back and the title. The
 * body scrolls under it, and Back from a Conversation opened here returns
 * here.
 */
export function CodePageFrame(props: {
  back?: { label: string; to: string };
  children: ReactNode;
  documentTitle?: string;
  /** The phone header names the page itself when this is unset. */
  phoneTitle?: string;
  returnPath: string;
  tabs?: ReactNode;
  title: string;
}) {
  const desktop = useSidebarFits();
  useDocumentTitle(props.documentTitle ?? props.title);
  useInboxReturnHere(props.returnPath);
  return (
    <section
      aria-label={props.title}
      className={cn(
        "grid h-full min-h-0 bg-dashboard-bg",
        desktop && "grid-rows-[auto_minmax(0,1fr)]",
      )}
    >
      {desktop ? (
        <HeaderBar actions={props.tabs} back={props.back} title={props.title} />
      ) : (
        <>
          {props.phoneTitle ? (
            <MobileHeaderTitlePortal>
              <h1
                className={cn(
                  fadeOverflowClass,
                  "m-0 text-left font-display text-sm font-medium text-dashboard-text",
                )}
                ref={fadeWhenOverflowing}
              >
                {props.phoneTitle}
              </h1>
            </MobileHeaderTitlePortal>
          ) : null}
          {props.tabs ? (
            <MobileHeaderActionsPortal>{props.tabs}</MobileHeaderActionsPortal>
          ) : null}
        </>
      )}
      <div className="thin-scrollbar min-h-0 overflow-y-auto">
        <PageLayout>{props.children}</PageLayout>
      </div>
    </section>
  );
}
