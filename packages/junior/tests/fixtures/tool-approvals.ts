import type { ToolApprovals } from "@/chat/guardian/gate";

/** Tool approvals of a Run where no person can approve, so `ask` denies. */
export const noToolApprovals: ToolApprovals = {
  async findPending() {
    return undefined;
  },
  async request() {
    return undefined;
  },
};
