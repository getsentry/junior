import { z } from "zod";

/** Longest customization text one user can save. */
export const USER_CUSTOMIZATION_MAX_CHARS = 1_000;

/** Saved customization text. An empty string means none. */
export const userCustomizationTextSchema = z
  .string()
  .trim()
  .max(USER_CUSTOMIZATION_MAX_CHARS);

/** Request and response body for the viewer's customization. */
export const userCustomizationSchema = z
  .object({ customization: userCustomizationTextSchema })
  .strict();
