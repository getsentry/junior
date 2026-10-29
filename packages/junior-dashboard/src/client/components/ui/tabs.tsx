import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "@dashboard/lib/utils";

/** Own the selected panel and link each tab to its panel. */
function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("grid min-w-0 gap-4", className)}
      {...props}
    />
  );
}

/** Draw the pill track. Tabs share the row equally on wide screens. */
function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "flex min-w-0 gap-1 rounded-lg border border-dashboard-border bg-dashboard-surface-panel p-1",
        className,
      )}
      {...props}
    />
  );
}

/** Select one panel. The active tab uses the strong fill. */
function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex min-h-9 min-w-0 flex-auto cursor-pointer items-center justify-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-2 font-sans text-xs font-medium text-dashboard-text-muted transition-colors hover:bg-dashboard-fill-faint hover:text-dashboard-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus data-active:bg-dashboard-fill-strong data-active:text-dashboard-text sm:flex-1",
        className,
      )}
      {...props}
    />
  );
}

/** Show the content for the selected tab. */
function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn(
        "min-w-0 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus",
        className,
      )}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
