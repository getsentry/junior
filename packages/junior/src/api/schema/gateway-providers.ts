import * as z from "zod";

export { gatewayOnlyProviders } from "../../chat/gateway-providers/rule";

const providerSlugSchema = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9-]*$/)
  .max(64);

/** The "Enabled providers" setting, with what the gateway lists for each model. */
export const gatewayProvidersSchema = z
  .object({
    /** Null when every provider is enabled. */
    enabled: z.array(z.string()).nullable(),
    /** Every provider that serves one of the models below. */
    providers: z.array(z.string()),
    /** Models that the agent runs, with the providers that serve each. */
    models: z.array(
      z.object({ id: z.string(), providers: z.array(z.string()) }).strict(),
    ),
  })
  .strict();

export const updateGatewayProvidersBodySchema = z
  .object({ enabled: z.array(providerSlugSchema).max(100).nullable() })
  .strict();

export type GatewayProviders = z.infer<typeof gatewayProvidersSchema>;
