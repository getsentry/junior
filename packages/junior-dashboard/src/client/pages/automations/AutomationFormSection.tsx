import type { ReactNode } from "react";

/** Keep section headings and fields aligned without nested form cards. */
export function AutomationFormSection(props: {
  title: string;
  detail?: string;
  children: ReactNode;
}) {
  return (
    <section className="grid min-w-0 gap-5 border-t border-dashboard-border-emphasis py-8 md:grid-cols-[12rem_minmax(0,1fr)] md:gap-10">
      <div>
        <h2 className="m-0 font-display text-lg font-medium">{props.title}</h2>
        {props.detail ? (
          <p className="mt-2 mb-0 text-sm leading-relaxed text-dashboard-text-muted">
            {props.detail}
          </p>
        ) : null}
      </div>
      <div className="grid min-w-0 content-start gap-5">{props.children}</div>
    </section>
  );
}
