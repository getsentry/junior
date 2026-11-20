import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getDashboardAgentName } from "../agentName";
import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Ellipsis,
  LockKeyhole,
  type LucideIcon,
} from "lucide-react";
import {
  conversationPlanItemSchema,
  conversationPlanReportSchema,
  type ConversationPlanItem,
  type PlanItemStatusBody,
} from "@sentry/junior/api/schema";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { DisplayText } from "../display-text/DisplayText";
import { fetchDashboardJson, patch } from "../http";
import { cn } from "../styles";
import { conversationSideReadQueryKey } from "./conversationSideReads";
import {
  DetailsCard,
  DetailsList,
  DetailsRow,
  DetailsRowLine,
} from "./DetailsList";

/** Load the open Plan items of one Conversation, then the latest closed ones. */
export function useConversationPlan(conversationId: string) {
  return useQuery({
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        conversationPlanReportSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/plan`,
        signal,
      ),
    queryKey: conversationSideReadQueryKey(conversationId, "plan"),
    retry: false,
  });
}

const statusIcons: Record<ConversationPlanItem["status"], LucideIcon> = {
  pending: Circle,
  in_progress: CircleDashed,
  blocked: CircleAlert,
  done: CircleCheck,
  cancelled: CircleX,
};

const statusLabels: Record<ConversationPlanItem["status"], string> = {
  pending: "Pending",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

function assigneeLabel(item: ConversationPlanItem): string {
  const { assignee } = item;
  if (assignee.kind === "self") return getDashboardAgentName();
  if (assignee.kind === "agent") return assignee.name ?? "Child agent";
  return assignee.name ?? "Person";
}

/**
 * Show the Plan of one Conversation: open items, then recently closed ones,
 * each with its status and assignee. Participants can close or reopen an
 * item. The agent sees that change on its next Turn.
 */
export function ConversationPlan(props: {
  canEdit: boolean;
  conversationId: string;
}) {
  const items = useConversationPlan(props.conversationId).data?.items ?? [];
  if (items.length === 0) return null;
  const open = items.filter(
    (item) => item.status !== "done" && item.status !== "cancelled",
  ).length;
  return (
    <DetailsCard count={open} title="Plan">
      <DetailsList
        itemKey={(item) => String(item.id)}
        items={items}
        renderItem={(item) => (
          <PlanItemRow
            canEdit={props.canEdit && item.redacted !== true}
            conversationId={props.conversationId}
            item={item}
          />
        )}
      />
    </DetailsCard>
  );
}

function PlanItemRow(props: {
  canEdit: boolean;
  conversationId: string;
  item: ConversationPlanItem;
}) {
  const { item } = props;
  const Icon = item.redacted ? LockKeyhole : statusIcons[item.status];
  const closed = item.status === "done" || item.status === "cancelled";
  const row = (
    <DetailsRow
      icon={
        <Icon
          aria-label={statusLabels[item.status]}
          className={cn(
            "size-3.5",
            // Same tones as the Thread and Task status icons.
            item.status === "in_progress" && "text-dashboard-accent",
            item.status === "blocked" && "text-amber-400",
            closed && "text-dashboard-text-faint",
          )}
          role="img"
        />
      }
      meta={assigneeLabel(item)}
      title={
        <span
          className={cn(closed && "text-dashboard-text-muted line-through")}
        >
          {item.title ?? "Private item"}
        </span>
      }
      tooltip={item.changedBy ? `Changed by ${item.changedBy}` : undefined}
    >
      {item.notes ? (
        <DetailsRowLine className="line-clamp-2 break-words">
          <DisplayText inline text={item.notes} />
        </DetailsRowLine>
      ) : null}
    </DetailsRow>
  );
  if (!props.canEdit) return row;
  return (
    <div className="flex min-w-0 items-start gap-0.5">
      <div className="min-w-0 flex-1">{row}</div>
      <PlanItemMenu
        closed={closed}
        conversationId={props.conversationId}
        item={item}
      />
    </div>
  );
}

function PlanItemMenu(props: {
  closed: boolean;
  conversationId: string;
  item: ConversationPlanItem;
}) {
  const setStatus = useSetPlanItemStatus(props.conversationId, props.item.id);
  const actions: Array<{
    label: string;
    status: PlanItemStatusBody["status"];
  }> = props.closed
    ? [{ label: "Reopen", status: "pending" }]
    : [
        { label: "Mark done", status: "done" },
        { label: "Cancel", status: "cancelled" },
      ];
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label={`Change ${props.item.title ?? "plan item"}`}
        className="grid size-8 shrink-0 place-items-center rounded-md text-dashboard-text-muted transition-colors hover:bg-dashboard-surface-hover hover:text-dashboard-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus"
        disabled={setStatus.isPending}
      >
        <Ellipsis aria-hidden="true" size={15} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.status}
            onClick={() => setStatus.mutate(action.status)}
          >
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function useSetPlanItemStatus(conversationId: string, itemId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (status: PlanItemStatusBody["status"]) =>
      patch(
        conversationPlanItemSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/plan/${itemId}`,
        { status },
      ),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: conversationSideReadQueryKey(conversationId, "plan"),
      }),
  });
}
