import { LogIn, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type CodexAuthStatus = {
  status: "missing" | "expired" | "authenticated";
  configured: boolean;
  accountId: string;
  email: string;
  profileId: string;
};

export function CodexAuthBox({
  auth,
  busy,
  canAuth,
  saveFirstText = "Save provider first",
  onLogin,
  onLogout
}: {
  auth?: CodexAuthStatus;
  busy: boolean;
  canAuth: boolean;
  saveFirstText?: string;
  onLogin: () => void;
  onLogout: () => void;
}) {
  const configured = Boolean(auth?.configured);
  const statusText = configured ? auth?.email || auth?.accountId || "Signed in" : "Not signed in";
  const detail = configured
    ? auth?.status === "expired"
      ? "Expired"
      : "Authenticated"
    : canAuth
      ? "OAuth browser sign-in"
      : saveFirstText;

  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2">
      <div className="min-w-0">
        <div
          className={cn(
            "truncate text-sm font-medium",
            configured ? "text-phase-done" : "text-muted-foreground"
          )}
        >
          {statusText}
        </div>
        <div className="truncate text-xs text-muted-foreground">{detail}</div>
      </div>
      {configured ? (
        <Button variant="outline" size="sm" onClick={onLogout} disabled={busy}>
          <LogOut className="h-3.5 w-3.5" />
          <span>{busy ? "Signing out" : "Sign out"}</span>
        </Button>
      ) : (
        <Button variant="outline" size="sm" onClick={onLogin} disabled={busy || !canAuth}>
          <LogIn className="h-3.5 w-3.5" />
          <span>{busy ? "Opening" : "Sign in"}</span>
        </Button>
      )}
    </div>
  );
}
