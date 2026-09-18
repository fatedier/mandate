import { ArrowUpRight, FileText } from "lucide-react";
import { useLocation, useNavigate } from "react-router";

interface CanvasReferenceCardProps {
  title: string;
  path: string;
}

export function CanvasReferenceCard({ title, path }: CanvasReferenceCardProps) {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <button
      type="button"
      onClick={() => navigate(path, { state: { backgroundLocation: location } })}
      className="group my-1 flex w-full max-w-xl items-center gap-3 rounded-md border border-border bg-panel px-3 py-2 text-left transition hover:bg-sel"
      aria-label={`Open canvas: ${title}`}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-sel text-muted-foreground">
        <FileText className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block label-micro text-chrome">
          Canvas
        </span>
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
      </span>
      <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground transition group-hover:text-foreground" />
    </button>
  );
}
