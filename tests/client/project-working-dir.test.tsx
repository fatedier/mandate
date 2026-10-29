import { expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { ChangeWorkingDirDialog } from "@/routes/projects/ChangeWorkingDirDialog";
import { ProjectActionsMenu } from "@/routes/projects/ProjectActionsMenu";
import { ChatMessageList } from "@/routes/window/chat/ChatMessageList";
import { newThreadState, type AgentMessage, type ThreadState } from "@/store/agent-chat";
import { projectChangeMetadata } from "@shared/project-change";
import { mockFetch } from "../helpers/fetch.js";
import { mount, mountAsync, settle } from "../helpers/mount.js";

const OLD = "/srv/checkouts/project-1-old";
const NEW = "/srv/checkouts/project-1";

const field = () => document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === name)!;
const dialogText = () => document.querySelector('[role="dialog"]')?.textContent ?? "";
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), value);
    field().dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

function dialog(inProjectWorkers: string[] = [], onDone = () => {}, workingDir = OLD) {
  return mountAsync(
    <MemoryRouter>
      <ChangeWorkingDirDialog projectId="p1" projectName="project-1" workingDir={workingDir} inProjectWorkers={inProjectWorkers} onDone={onDone} />
    </MemoryRouter>
  );
}

test("a directory stored with a trailing slash is unchanged as it opens, and so is it typed without one", async () => {
  mockFetch(() => Response.json({}));
  await dialog([], () => {}, `${OLD}/`);
  expect(button("Save").disabled).toBe(true);
  await type(OLD);
  expect(button("Save").disabled).toBe(true);
});

test("the root is unchanged as it opens, and a directory under it is a change", async () => {
  mockFetch(() => Response.json({}));
  await dialog([], () => {}, "/");
  expect(button("Save").disabled).toBe(true);
  await type("/srv");
  expect(button("Save").disabled).toBe(false);
});

test("the dialog opens on the project's directory; Save waits for another one, then sends it and closes", async () => {
  const calls = mockFetch(() => Response.json({ id: "p1", name: "project-1", workingDir: NEW }));
  let done = 0;
  await dialog([], () => { done += 1; });
  expect([field().value, button("Save").disabled]).toEqual([OLD, true]);
  await type(`${OLD}/`);
  expect(button("Save").disabled).toBe(true);
  await type(NEW);
  expect(button("Save").disabled).toBe(false);
  await act(async () => { button("Save").click(); });
  await settle();
  expect(calls.map((c) => [c.method, c.url, c.init?.body])).toStrictEqual([["PATCH", "/api/projects/p1", JSON.stringify({ workingDir: NEW })]]);
  expect(done).toBe(1);
});

test("a refusal stays in the dialog in the server's words", async () => {
  const refusal = `These workers' worktrees belong to another repository than ${NEW}: billing. Archive them first.`;
  mockFetch(() => Response.json({ error: refusal, workers: [{ id: "f2", name: "billing" }] }, { status: 409 }));
  let done = 0;
  await dialog([], () => { done += 1; });
  await type(NEW);
  await act(async () => { button("Save").click(); });
  await settle();
  expect([dialogText().includes(refusal), done, button("Save").disabled]).toEqual([true, 0, false]);
});

test("the workers that work in the project's directory are named: their panes stay where they are", async () => {
  mockFetch(() => Response.json({}));
  await dialog(["docs"]);
  expect(dialogText()).toContain('"docs" works in the project directory: panes already open in its window keep running in the old directory until they are restarted.');
});

test("several are named together", async () => {
  mockFetch(() => Response.json({}));
  await dialog(["docs", "api"]);
  expect(dialogText()).toContain('"api" and "docs" work in the project directory: panes already open in their windows keep running in the old directory until they are restarted.');
});

test("the project's menu offers the change, and opens the dialog on the project's directory", async () => {
  mockFetch(() => Response.json({}));
  const { host } = mount(
    <MemoryRouter>
      <ProjectActionsMenu projectId="p1" projectName="project-1" workingDir={OLD} inProjectWorkers={[]} hasTmuxSession canMoveUp={false} canMoveDown={false}
        onMoveToTop={() => {}} onMoveUp={() => {}} onMoveDown={() => {}} />
    </MemoryRouter>
  );
  // Radix opens on pointerdown, not click.
  act(() => {
    host.querySelector('[aria-label="Project actions"]')!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
  });
  await settle();
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((n) => n.textContent?.trim() === "Change working directory…");
  expect(item === undefined).toBe(false);
  await act(async () => { item!.click(); });
  await settle();
  expect(field()?.value).toBe(OLD);
});

test("in a chat the change is a line naming the new directory, not the user's bubble", async () => {
  const row: AgentMessage = {
    id: "m1", threadId: "thr-w", seq: 1, role: "user", source: "project-change", sourceThreadId: null, wakeId: null, createdAt: "2026-10-16T03:00:00Z",
    content: { type: "text", text: "[Project change] The user changed the working directory…", metadata: projectChangeMetadata({ projectId: "p1", projectName: "project-1", from: OLD, to: NEW }) }
  } as AgentMessage;
  const thread: ThreadState = { ...newThreadState(), threadId: "thr-w", messages: [row], oldestSeqLoaded: 1 };
  const { host } = await mountAsync(<ChatMessageList thread={thread} onLoadOlder={async () => {}} onRetryFailed={() => {}} />);
  await settle();
  const line = host.querySelector('[data-slot="context-boundary"]');
  expect([line?.textContent, line?.getAttribute("title")]).toEqual([`Working directory changed to ${NEW}`, `project-1: ${OLD} → ${NEW}`]);
  expect((host.textContent ?? "").includes("[Project change]")).toBe(false);
  // Nor does it get a bubble's actions: there is nothing of the user's to copy.
  expect(host.querySelector('[data-slot="row-actions"]') === null).toBe(true);
});
