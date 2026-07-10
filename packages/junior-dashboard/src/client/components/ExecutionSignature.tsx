import { cn } from "../styles";

/** Show the model execution settings without competing with transcript status. */
export function ExecutionSignature(props: {
  className?: string;
  modelId?: string;
  reasoningLevel?: string;
}) {
  const modelId = props.modelId?.trim();
  const reasoningLevel = props.reasoningLevel?.trim();
  if (!modelId && !reasoningLevel) return null;
  const modelName = modelId?.split("/").at(-1) ?? modelId;

  return (
    <span
      aria-label={
        modelId
          ? `Execution settings: ${modelId}${reasoningLevel ? `, ${reasoningLevel}` : ""}`
          : `Execution reasoning: ${reasoningLevel}`
      }
      className={cn(
        "font-mono text-[0.76rem] leading-snug text-[#aaa]",
        props.className,
      )}
      title={modelId}
    >
      {modelName}
      {reasoningLevel ? (
        <span className={modelName ? "text-[#888]" : undefined}>
          {modelName ? " " : null}({reasoningLevel})
        </span>
      ) : null}
    </span>
  );
}
