import { useEffect } from "react";
import { toast } from "sonner";
import { useSnapshotStore } from "@/store/snapshot";

export function BannerToaster() {
  const banner = useSnapshotStore((s) => s.banner);
  const clearBanner = useSnapshotStore((s) => s.clearBanner);

  useEffect(() => {
    if (!banner) return;
    toast.error(banner);
    clearBanner();
  }, [banner, clearBanner]);

  return null;
}
