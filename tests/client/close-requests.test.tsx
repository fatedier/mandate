import { expect, spyOn, test } from "bun:test";
import { act, useState, type ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { BottomSheet, BottomSheetTitle } from "@/components/ui/bottom-sheet";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SimpleSelect } from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { CloseRequests } from "@/lib/close-requests";
import { CanvasModal } from "@/routes/canvas/CanvasPage";
import { onCleanup } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";

// The phone's Back closes what is open over the page, as Esc does, instead
// of leaving the page. The browser's side is HTML's CloseWatcher: Back
// closes the newest active watcher, or goes back in history when there is
// none.

class FakeCloseWatcher {
  static active: FakeCloseWatcher[] = [];
  onclose: ((event: Event) => void) | null = null;
  constructor() {
    FakeCloseWatcher.active.push(this);
  }
  destroy() {
    FakeCloseWatcher.active = FakeCloseWatcher.active.filter((watcher) => watcher !== this);
  }
}

function browserWithCloseWatcher() {
  FakeCloseWatcher.active = [];
  (globalThis as { CloseWatcher?: unknown }).CloseWatcher = FakeCloseWatcher;
  onCleanup(() => { delete (globalThis as { CloseWatcher?: unknown }).CloseWatcher; });
  const historyBack = spyOn(window.history, "back").mockImplementation(() => {});
  onCleanup(() => historyBack.mockRestore());
  return historyBack;
}

/** The phone's Back, as the browser handles it. */
async function back(): Promise<void> {
  const watcher = FakeCloseWatcher.active.pop();
  await act(async () => {
    if (watcher) watcher.onclose?.(new Event("close"));
    else window.history.back();
  });
  await settle();
}

const shown = (role: string) => document.querySelector(`[role="${role}"]:not([data-state="closed"])`) !== null;

function EditDialog({ children, refuse = false }: { children?: ReactNode; refuse?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent onEscapeKeyDown={refuse ? (event) => event.preventDefault() : undefined}>
        <DialogTitle>Edit</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}

test("Back closes an open dialog instead of leaving the page", async () => {
  const historyBack = browserWithCloseWatcher();
  await mountAsync(<EditDialog />);
  await settle();
  expect(FakeCloseWatcher.active).toHaveLength(1);
  await back();
  expect(shown("dialog")).toBe(false);
  expect(historyBack).not.toHaveBeenCalled();
  // Nothing open: nothing watches, and the next Back is the page's.
  expect(FakeCloseWatcher.active).toHaveLength(0);
});

test("Back closes a menu open in a dialog first, then the dialog", async () => {
  const historyBack = browserWithCloseWatcher();
  function MenuInDialog() {
    const [menu, setMenu] = useState(true);
    return (
      <EditDialog>
        <DropdownMenu open={menu} onOpenChange={setMenu}>
          <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
          <DropdownMenuContent><DropdownMenuItem>Rename</DropdownMenuItem></DropdownMenuContent>
        </DropdownMenu>
      </EditDialog>
    );
  }
  await mountAsync(<MenuInDialog />);
  await settle();
  expect(shown("menu")).toBe(true);
  // One watcher stands for both.
  expect(FakeCloseWatcher.active).toHaveLength(1);
  await back();
  expect(shown("menu")).toBe(false);
  expect(shown("dialog")).toBe(true);
  expect(FakeCloseWatcher.active).toHaveLength(1);
  await back();
  expect(shown("dialog")).toBe(false);
  expect(historyBack).not.toHaveBeenCalled();
});

test("Back closes a menu open on the page", async () => {
  browserWithCloseWatcher();
  function PageMenu() {
    const [menu, setMenu] = useState(true);
    return (
      <DropdownMenu open={menu} onOpenChange={setMenu}>
        <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
        <DropdownMenuContent><DropdownMenuItem>Rename</DropdownMenuItem></DropdownMenuContent>
      </DropdownMenu>
    );
  }
  await mountAsync(<PageMenu />);
  await settle();
  expect(FakeCloseWatcher.active).toHaveLength(1);
  await back();
  expect(shown("menu")).toBe(false);
});

test("a dialog that refuses Esc refuses Back too, and is still watched", async () => {
  const historyBack = browserWithCloseWatcher();
  await mountAsync(<EditDialog refuse />);
  await settle();
  await back();
  expect(shown("dialog")).toBe(true);
  expect(FakeCloseWatcher.active).toHaveLength(1);
  expect(historyBack).not.toHaveBeenCalled();
});

test("Back closes a bottom sheet", async () => {
  browserWithCloseWatcher();
  function Calls() {
    const [open, setOpen] = useState(true);
    return (
      <BottomSheet open={open} onOpenChange={setOpen} header={<BottomSheetTitle>2 tool calls</BottomSheetTitle>}>
        <p>bun test</p>
      </BottomSheet>
    );
  }
  await mountAsync(<Calls />);
  await settle();
  expect(FakeCloseWatcher.active).toHaveLength(1);
  await back();
  expect(shown("dialog")).toBe(false);
});

test("Back closes a side sheet and a popover", async () => {
  browserWithCloseWatcher();
  function Overlay({ which }: { which: "sheet" | "popover" }) {
    const [open, setOpen] = useState(true);
    if (which === "sheet") {
      return <Sheet open={open} onOpenChange={setOpen}><SheetContent><SheetTitle>Navigation</SheetTitle></SheetContent></Sheet>;
    }
    return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger>Reply</PopoverTrigger><PopoverContent>The reply</PopoverContent></Popover>;
  }
  for (const which of ["sheet", "popover"] as const) {
    const mounted = await mountAsync(<Overlay which={which} />);
    await settle();
    expect([which, FakeCloseWatcher.active.length]).toEqual([which, 1]);
    await back();
    expect([which, shown("dialog")]).toEqual([which, false]);
    mounted.unmount();
  }
});

test("Back closes a select's list", async () => {
  browserWithCloseWatcher();
  function Effort() {
    const [value, setValue] = useState("low");
    return <SimpleSelect aria-label="Effort" value={value} onValueChange={setValue} options={[{ value: "low", label: "Low" }, { value: "high", label: "High" }]} />;
  }
  const { host } = await mountAsync(<Effort />);
  await settle();
  // Closed, Radix keeps the list in a detached fragment: nothing is open, so
  // nothing watches (else an Esc on the page would go back in history).
  expect(FakeCloseWatcher.active).toHaveLength(0);
  const trigger = host.querySelector<HTMLElement>('[aria-label="Effort"]')!;
  trigger.focus();
  await act(async () => { trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); });
  await settle();
  expect(shown("listbox")).toBe(true);
  expect(FakeCloseWatcher.active).toHaveLength(1);
  await back();
  expect(shown("listbox")).toBe(false);
  expect(FakeCloseWatcher.active).toHaveLength(0);
});

test("Back closes a context menu", async () => {
  browserWithCloseWatcher();
  // Radix anchors the menu at the press with a DOMRect, which the test DOM
  // keeps on its window only.
  const globals = globalThis as { DOMRect?: unknown };
  if (!globals.DOMRect) {
    globals.DOMRect = (window as unknown as { DOMRect: unknown }).DOMRect;
    onCleanup(() => { delete globals.DOMRect; });
  }
  const { host } = await mountAsync(
    <ContextMenu>
      <ContextMenuTrigger><p>a row</p></ContextMenuTrigger>
      <ContextMenuContent><ContextMenuItem>Copy</ContextMenuItem></ContextMenuContent>
    </ContextMenu>
  );
  await act(async () => { host.querySelector("p")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
  await settle();
  expect(shown("menu")).toBe(true);
  expect(FakeCloseWatcher.active).toHaveLength(1);
  await back();
  expect(shown("menu")).toBe(false);
});

// The canvas opens as a page of its own (a route) over the one it came from:
// Back closes it onto that page, one step, as its Close does.
test("Back closes the canvas modal onto the page it covered", async () => {
  const historyBack = browserWithCloseWatcher();
  mockFetch(() => jsonResponse({ canvas: {
    id: "cnv_a", title: "Report", kind: "report", html: "<title>x</title><p>x</p>", contentRevision: 1,
    scope: "manager", scopeId: null, projectId: null, projectName: null, projectSlug: null,
    featureId: null, featureName: null, featureSlug: null, threadId: "t1",
    createdAt: "2026-09-28T00:00:00.000Z", updatedAt: "2026-09-28T00:00:00.000Z"
  } }));
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/", "/canvas/cnv_a"]} initialIndex={1}>
      <Routes>
        <Route path="/" element={<p data-testid="home">home</p>} />
        <Route path="/canvas/:canvasId" element={<CanvasModal />} />
      </Routes>
    </MemoryRouter>
  );
  await settle();
  expect(FakeCloseWatcher.active).toHaveLength(1);
  await back();
  expect(document.querySelector('[role="dialog"][aria-label="Canvas"]') === null).toBe(true);
  expect(host.querySelector('[data-testid="home"]')).not.toBeNull();
  expect(historyBack).not.toHaveBeenCalled();
});

// Still mounted, already closed: the last overlay on its way out.
test("Back with nothing left open is the page's Back", async () => {
  const historyBack = browserWithCloseWatcher();
  await mountAsync(<CloseRequests />);
  await settle();
  expect(FakeCloseWatcher.active).toHaveLength(1);
  await back();
  expect(historyBack).toHaveBeenCalledTimes(1);
});

test("in a browser without CloseWatcher an overlay opens and closes as before", async () => {
  await mountAsync(<EditDialog />);
  await settle();
  expect(shown("dialog")).toBe(true);
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  await settle();
  expect(shown("dialog")).toBe(false);
});
