import { Skeleton } from "../../components/Skeleton";
import { AutomationFormSection } from "./AutomationFormSection";

/** Keep the editor's field columns stable while exact values load. */
export function AutomationEditorLoading() {
  return (
    <div role="status" aria-label="Loading automation editor">
      {["What to do", "When to run", "Where results go", "Credentials"].map(
        (title, index) => (
          <AutomationFormSection key={title} title={title} detail="">
            <Skeleton className="h-4 w-24" />
            <Skeleton className={index === 0 ? "h-48 w-full" : "h-20 w-full"} />
          </AutomationFormSection>
        ),
      )}
    </div>
  );
}
