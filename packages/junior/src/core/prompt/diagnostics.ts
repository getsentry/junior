// What core reports about how it built one prompt: the size of each system
// prompt section, how each loader ran and what happened to each fragment.
// It holds no content, so it is safe to log and to store.

/** One section of the system prompt. */
type SystemPromptSectionDiagnostics = {
  name: string;
  /** The length of the section's text. */
  chars: number;
};

/** How one loader ran for a prompt. */
export type LoaderDiagnostics = {
  label: string;
  /** How long the request waited for the value. */
  ms: number;
  status: "ok" | "failed" | "timed_out";
};

/** What happened to one fragment of a prompt. */
export type FragmentDiagnostics = {
  name: string;
  field: "messages";
  /** `skipped`: `format` returned `skip`. `disabled`: `enabled` returned false. */
  status: "included" | "skipped" | "disabled";
  /** The reason that `skip` gave. */
  reason?: string;
};

/** How core built one prompt. Each list is in layout order. */
export type PromptDiagnostics = {
  systemPrompt: SystemPromptSectionDiagnostics[];
  loaders: LoaderDiagnostics[];
  fragments: FragmentDiagnostics[];
};
