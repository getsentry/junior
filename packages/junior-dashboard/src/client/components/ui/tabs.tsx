import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cva, type VariantProps } from "class-variance-authority";
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

const tabsListVariants = cva("group/tabs-list flex min-w-0", {
  variants: {
    variant: {
      /** A pill track. Tabs share the row equally on wide screens. */
      default:
        "gap-1 rounded-lg border border-dashboard-border bg-dashboard-surface-panel p-1",
      /** Underlined tabs on a bottom border, for collection filters. */
      line: "gap-1 border-b border-dashboard-border-subtle",
    },
  },
  defaultVariants: { variant: "default" },
});

/** Hold the tabs. `variant` sets the look of the row and its tabs. */
function TabsList({
  className,
  variant = "default",
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

/** Select one panel. The active tab uses the strong fill or the accent line. */
function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex min-w-0 cursor-pointer items-center gap-1.5 border-0 bg-transparent font-sans text-xs font-medium text-dashboard-text-muted transition-colors hover:text-dashboard-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus",
        "group-data-[variant=default]/tabs-list:min-h-9 group-data-[variant=default]/tabs-list:flex-auto group-data-[variant=default]/tabs-list:justify-center group-data-[variant=default]/tabs-list:rounded-md group-data-[variant=default]/tabs-list:px-1.5 group-data-[variant=default]/tabs-list:py-2 group-data-[variant=default]/tabs-list:hover:bg-dashboard-fill-faint group-data-[variant=default]/tabs-list:data-active:bg-dashboard-fill-strong group-data-[variant=default]/tabs-list:data-active:text-dashboard-text group-data-[variant=default]/tabs-list:sm:flex-1",
        "group-data-[variant=line]/tabs-list:relative group-data-[variant=line]/tabs-list:gap-2 group-data-[variant=line]/tabs-list:px-3 group-data-[variant=line]/tabs-list:py-2.5 group-data-[variant=line]/tabs-list:after:absolute group-data-[variant=line]/tabs-list:after:inset-x-2 group-data-[variant=line]/tabs-list:after:bottom-0 group-data-[variant=line]/tabs-list:after:h-px group-data-[variant=line]/tabs-list:data-active:text-dashboard-accent-text group-data-[variant=line]/tabs-list:data-active:after:bg-dashboard-accent",
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
