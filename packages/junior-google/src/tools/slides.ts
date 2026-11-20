/** Inputs shared by the Google Slides layout, thumbnail, and edit tools. */
import * as z from "zod";
import { fileReferenceSchema } from "./files";

export const presentationReferenceSchema = fileReferenceSchema("Google Slides");

/** A slide's page object id, as the Slides API returns it. */
export const slideObjectIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_:-]{1,100}$/)
  .describe("Slide objectId from readGoogleSlidesLayout.");

/** Return the editor link of a presentation. */
export function presentationUrl(presentationId: string): string {
  return `https://docs.google.com/presentation/d/${presentationId}/edit`;
}
