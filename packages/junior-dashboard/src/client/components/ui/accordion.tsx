// Adapted from shadcn/ui Base UI Accordion. Copyright (c) 2023 shadcn. MIT license: see ../README.md#third-party-notices.
import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";
import { cn } from "@dashboard/lib/utils";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";

/** Group sections with Base UI disclosure and keyboard behavior. */
function Accordion({ className, ...props }: AccordionPrimitive.Root.Props) {
  return (
    <AccordionPrimitive.Root
      data-slot="accordion"
      className={cn("flex w-full flex-col", className)}
      {...props}
    />
  );
}

/** Keep one section’s trigger and panel state together. */
function AccordionItem({ className, ...props }: AccordionPrimitive.Item.Props) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn(
        "not-last:border-b not-last:border-dashboard-border-subtle",
        className,
      )}
      {...props}
    />
  );
}

/** Render the section heading and its expand or collapse control. */
function AccordionTrigger({
  className,
  children,
  ...props
}: AccordionPrimitive.Trigger.Props) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "group/accordion-trigger relative flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-3 rounded-sm py-2.5 text-left font-sans text-sm font-medium text-dashboard-text transition-colors hover:text-dashboard-text-solid outline-none focus-visible:outline-2 focus-visible:outline-dashboard-focus aria-disabled:pointer-events-none aria-disabled:opacity-50 **:data-[slot=accordion-trigger-icon]:ml-auto **:data-[slot=accordion-trigger-icon]:size-4 **:data-[slot=accordion-trigger-icon]:text-dashboard-text-muted",
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDownIcon
          data-slot="accordion-trigger-icon"
          className="pointer-events-none shrink-0 group-aria-expanded/accordion-trigger:hidden"
        />
        <ChevronUpIcon
          data-slot="accordion-trigger-icon"
          className="pointer-events-none hidden shrink-0 group-aria-expanded/accordion-trigger:inline"
        />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

/** Reveal section content with measured height and reduced-motion support. */
function AccordionContent({
  className,
  children,
  ...props
}: AccordionPrimitive.Panel.Props) {
  return (
    <AccordionPrimitive.Panel
      data-slot="accordion-content"
      className="h-(--accordion-panel-height) overflow-hidden text-sm transition-[height] duration-180 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none"
      {...props}
    >
      <div className={cn("pt-0 pb-2.5", className)}>{children}</div>
    </AccordionPrimitive.Panel>
  );
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
