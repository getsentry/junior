import { getDashboardAgentName } from "../agentName";

/** Show that Junior is actively composing the next assistant message. */
export function TranscriptTypingIndicator() {
  return (
    <div aria-live="polite" className="mt-2 flex items-center" role="status">
      <span className="sr-only">{getDashboardAgentName()} is responding</span>
      <span className="flex items-center gap-1 rounded-full bg-white/[0.04] px-2 py-1.5">
        {[0, 1, 2].map((dot) => (
          <span
            aria-hidden="true"
            className="size-1.5 animate-bounce rounded-full bg-cyan-100/70 motion-reduce:animate-none"
            key={dot}
            style={{ animationDelay: `${dot * 150}ms` }}
          />
        ))}
      </span>
    </div>
  );
}
