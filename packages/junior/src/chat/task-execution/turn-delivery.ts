import { z } from "zod";

/** Select where visible assistant messages for one turn are delivered. */
export const turnDeliverySchema = z.enum(["destination", "conversation"]);

/** Delivery target for visible assistant messages from one turn. */
export type TurnDelivery = z.output<typeof turnDeliverySchema>;
