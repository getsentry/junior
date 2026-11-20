import { modelClient } from "@/core/model/client";
import { getGatewayApiKey } from "@/chat/pi/gateway-auth";
import { resolveGatewayModel } from "@/chat/pi/client";

/** The model client for AI Gateway, with Junior's credentials and model catalog. */
export const gatewayModelClient = modelClient({
  apiKey: getGatewayApiKey,
  resolveModel: resolveGatewayModel,
});
