import { useLocation, useSearchParams } from "react-router";
import { useProjectsStore } from "@/store/projects";
import { SetupChecklist } from "@/routes/projects/SetupChecklist";
import { NewThreadComposer } from "@/routes/threads/NewThreadComposer";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/lib/utils";
import { WaitingOnYou } from "./WaitingOnYou";

/** Home: what waits on you, most urgent first, and a
 *  composer that starts a new thread. First runs get the setup checklist.
 *
 *  A desktop centres the question and the composer with what waits under
 *  them, the group as a whole, as a new chat does in a chat app; it
 *  starts at the top and scrolls when it is taller than the page (`my-auto`
 *  gives way, where centring would clip). A phone keeps the composer at the
 *  bottom, in thumb reach and where the keyboard opens, with what waits
 *  above it. The document follows what each shows — a screen reader and Tab
 *  meet them in that order — and the keys keep a draft in the composer when
 *  the window crosses the breakpoint. */
export function HomePage() {
  const projects = useProjectsStore((s) => s.projects);
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const focusComposer = searchParams.get("focus") === "composer";
  const isMobile = useIsMobile();
  const composer = (
    <div key="composer" className={cn("flex flex-col gap-3", isMobile && "mt-auto")}>
      <h1 className="text-center text-lg font-semibold text-foreground">What should we work on?</h1>
      <NewThreadComposer autoFocus={focusComposer} focusKey={focusComposer ? location.key : undefined} />
    </div>
  );
  const waiting = <WaitingOnYou key="waiting" />;
  return (
    <div className="mx-auto flex w-full max-w-[44rem] flex-1 flex-col px-4 pt-6 pb-8">
      <div className={cn("flex flex-col gap-8", isMobile ? "flex-1" : "my-auto")}>
        <SetupChecklist hasProjects={projects.length > 0} />
        {(isMobile ? [waiting, composer] : [composer, waiting])}
      </div>
    </div>
  );
}
