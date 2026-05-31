import { JuniorLogo } from "./JuniorLogo";

/** Render the full-page loading treatment before the first dashboard payload lands. */
export function LoadingView(props: { label: string }) {
  return (
    <div className="grid min-h-[calc(100vh-5rem)] place-items-center px-4 py-8 md:px-8">
      <section className="grid w-full max-w-lg grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border border-white/15 bg-[#0b0b0b] p-4">
        <JuniorLogo />
        <div>
          <div className="font-bold">{props.label}</div>
          <div className="mt-3 h-1.5 w-full animate-pulse bg-white/20" />
        </div>
      </section>
    </div>
  );
}
