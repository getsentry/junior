import { getDashboardAgentName } from "../agentName";
import { ShimmerText } from "../components/ShimmerText";

/** Show that Junior is actively composing the next assistant message. */
export function TranscriptTypingIndicator() {
  const label = `${getDashboardAgentName()} is thinking…`;

  return (
    <div
      aria-live="polite"
      className="flex items-center text-sm text-dashboard-text-muted"
      role="status"
    >
      <ShimmerText active>{label}</ShimmerText>
    </div>
  );
}
