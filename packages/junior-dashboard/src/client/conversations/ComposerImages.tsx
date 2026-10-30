import { X } from "lucide-react";
import {
  INPUT_IMAGE_TYPES,
  MAX_INPUT_IMAGE_BYTES,
  MAX_INPUT_IMAGES,
  type InputImage,
  type MessageAttachment,
} from "@sentry/junior/api/schema";
import { Button } from "../components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import {
  conversationAttachmentUrl,
  inputImageSrc,
} from "./TranscriptAttachment";

/** Decoded size of base64 image data, as the server limit counts it. */
function inputImageBytes(images: readonly InputImage[]): number {
  return images.reduce((sum, image) => sum + (image.data.length * 3) / 4, 0);
}

/** True when these images fit the message image count and size limits. */
export function composerImagesFit(images: readonly InputImage[]): boolean {
  return (
    images.length <= MAX_INPUT_IMAGES &&
    inputImageBytes(images) <= MAX_INPUT_IMAGE_BYTES
  );
}

/** Read a bounded image selection for the message request and local previews. */
export async function readComposerImages(
  files: File[],
  current: InputImage[],
): Promise<InputImage[]> {
  if (current.length + files.length > MAX_INPUT_IMAGES)
    throw new Error("Attach up to 3 images.");
  const currentBytes = inputImageBytes(current);
  if (
    currentBytes + files.reduce((sum, file) => sum + file.size, 0) >
    MAX_INPUT_IMAGE_BYTES
  ) {
    throw new Error("Images must total 3 MB or less.");
  }
  if (
    files.some(
      (file) =>
        !INPUT_IMAGE_TYPES.some((type) => type === file.type) || !file.size,
    )
  ) {
    throw new Error("Use PNG, JPEG, GIF, or WebP image files.");
  }
  const images = await Promise.all(
    files.map(
      (file) =>
        new Promise<InputImage>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () =>
            reject(new Error("Could not read the image. Add it again."));
          reader.onload = () =>
            resolve({
              filename: file.name || "image.png",
              contentType: file.type as InputImage["contentType"],
              data: String(reader.result).split(",", 2)[1]!,
            });
          reader.readAsDataURL(file);
        }),
    ),
  );
  return [...current, ...images];
}

/** Read stored image attachments back into composer images for an edit. */
export async function readStoredComposerImages(
  conversationId: string,
  attachments: readonly MessageAttachment[] | undefined,
): Promise<InputImage[]> {
  const images = (attachments ?? []).filter((attachment) =>
    INPUT_IMAGE_TYPES.some((type) => type === attachment.contentType),
  );
  const files = await Promise.all(
    images.map(async (attachment) => {
      const response = await fetch(
        conversationAttachmentUrl(conversationId, attachment.id),
      );
      if (!response.ok) throw new Error("Could not read the queued image.");
      return new File([await response.blob()], attachment.filename, {
        type: attachment.contentType,
      });
    }),
  );
  return await readComposerImages(files, []);
}

/** Show removable images before sending; bytes stay in memory until submit. */
export function ComposerImages(props: {
  images: InputImage[];
  disabled?: boolean;
  onRemove(index: number): void;
}) {
  return (
    <div className="col-span-full flex min-w-0 flex-wrap gap-2 px-3 pt-3">
      {props.images.map((image, index) => (
        <div
          className="relative min-w-0 rounded-lg border border-dashboard-border p-1"
          key={index}
        >
          <img
            alt={image.filename}
            className="h-20 w-24 rounded-md object-contain"
            src={inputImageSrc(image)}
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={`Remove ${image.filename}`}
                  className="absolute right-0 top-0 size-7 rounded-full border border-dashboard-border bg-dashboard-surface-raised text-dashboard-text data-disabled:hover:!bg-dashboard-surface-raised data-disabled:hover:!text-dashboard-text"
                  disabled={props.disabled}
                  focusableWhenDisabled
                  onClick={() => props.onRemove(index)}
                  size="icon"
                  type="button"
                >
                  <X aria-hidden="true" size={14} />
                </Button>
              }
            />
            <TooltipContent size="compact">Remove image</TooltipContent>
          </Tooltip>
        </div>
      ))}
    </div>
  );
}
