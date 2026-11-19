import { ImageViewer } from "@/components/ImageViewer";
import { cn } from "@/lib/utils";

export interface TileImage {
  id: string;
  alt: string;
  thumb: string;
  original: string;
}

/** Images in the transcript, an attached one's or the ones a tool viewed:
 *  small tiles of their tops, each opening the whole original in place. With
 *  a limit, the last tile shown says how many more there are. */
export function ImageTiles({ images, limit, className }: { images: TileImage[]; limit?: number; className?: string }) {
  const shown = limit === undefined ? images : images.slice(0, limit);
  const more = images.length - shown.length;
  return (
    <div data-slot="image-tiles" className={cn("grid max-w-64 grid-cols-2 gap-1.5", className)}>
      {shown.map((image, index) => (
        <ImageViewer
          key={image.id}
          src={image.original}
          alt={image.alt}
          className="relative block w-full overflow-hidden rounded-md border border-border-soft bg-background/60 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
        >
          <img src={image.thumb} alt={image.alt} loading="lazy" decoding="async" className="h-24 w-full object-cover object-top" />
          {more > 0 && index === shown.length - 1 && (
            <span data-slot="image-tiles-more" className="absolute inset-0 flex items-center justify-center bg-background/70 text-sm text-foreground">
              +{more}
            </span>
          )}
        </ImageViewer>
      ))}
    </div>
  );
}
