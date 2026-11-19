import { useEffect } from "react";
import { useLocation } from "react-router";
import { findSectionRoot, rememberSection } from "@/lib/section-memory";
import { navItems } from "@/shell/nav-config";

const ROOTS = navItems.map((item) => item.to);

export function useSectionTracking(): void {
  const location = useLocation();
  useEffect(() => {
    const root = findSectionRoot(location.pathname, ROOTS);
    if (root) {
      rememberSection(root, location.pathname + location.search);
    }
  }, [location.pathname, location.search]);
}
