import { withJunior } from "junior/config";
import workflowNext from "workflow/next";
const { withWorkflow } = workflowNext;

export default withWorkflow(withJunior());
