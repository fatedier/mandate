import { useCallback, useState, type ReactNode } from "react";
import { ImageLightbox } from "@/components/ImageViewer";
import type { FramePicture } from "./canvas-bridge";

/** The pictures a press in a report opened, and which one is shown. */
export interface CanvasGallery {
  pictures: FramePicture[];
  index: number;
}

/**
 * A report's pictures over the page, kept outside the report's frame: a
 * republish remounts the frame, and the picture being looked at stays (its
 * paging keeps the pictures it opened with). `frame` finds the report's frame
 * as it is now, which gets the focus back when the picture closes. Closed, the
 * last pictures are kept so the viewer fades out.
 */
export function useCanvasPictures(canvasId: string, frame: () => HTMLElement | null, title?: string): {
  onPictures: (gallery: CanvasGallery) => void;
  viewer: ReactNode;
} {
  const [gallery, setGallery] = useState<(CanvasGallery & { canvasId: string; open: boolean }) | null>(null);
  const onPictures = useCallback((next: CanvasGallery) => setGallery({ ...next, canvasId, open: true }), [canvasId]);
  // Another canvas in the same view (a dialog serves every canvas) starts with none.
  const shown = gallery?.canvasId === canvasId ? gallery : null;
  const picture = shown?.pictures[shown.index];
  const viewer = shown && picture ? (
    <ImageLightbox
      open={shown.open}
      onOpenChange={(open) => { if (!open) setGallery((g) => g && { ...g, open: false }); }}
      returnFocus={frame}
      src={picture.src}
      alt={picture.caption || title || "Picture"}
      paging={{
        index: shown.index,
        count: shown.pictures.length,
        caption: picture.caption,
        onStep: (delta) => setGallery((g) => g && { ...g, index: (g.index + delta + g.pictures.length) % g.pictures.length })
      }}
    />
  ) : null;
  return { onPictures, viewer };
}
