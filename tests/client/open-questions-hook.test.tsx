import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { useOpenQuestions } from "@/hooks/useOpenQuestions";
import { useWorkerQuestionTone } from "@/hooks/useWorkerQuestionTone";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useProjectsStore } from "@/store/projects";
import { useWorkerPlansStore } from "@/store/worker-plans";
import { useThreadStatusStore } from "@/store/thread-status";
import { emptyPlan } from "@shared/api/plans";
import type { WaitingEntryDto } from "@shared/api/thread-status";
import { runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";
import { clientWorker, clientProject, managerThreadDto } from "../helpers/client-builders.js";

const at = "2026-09-27T00:00:00.000Z";

afterEach(() => {
  runCleanups();
  act(() => {
    useManagerThreadsStore.setState({ threads: new Map(), loaded: false });
    useProjectsStore.getState().setProjectsState([]);
    useWorkerPlansStore.setState({ plans: new Map() });
    useThreadStatusStore.getState().replace({ threads: [], waiting: [] });
  });
});

function Questions() {
  const shown = useOpenQuestions({ type: "manager", threadId: "thr_a" });
  return <ul>{shown.map((q) => <li key={q.id}>{q.question}</li>)}</ul>;
}

const asking = (threadId: string): WaitingEntryDto => ({
  key: "worker:evict:input", kind: "worker", waiting: "input", threadId, threadTitle: "project-1 release",
  workerId: "evict", workerName: "evict", text: "Keep the old flag as an alias?", place: null
});

// A question stands where it was asked: over a manager thread's composer, its
// manager's own; a worker's stays in the worker's own view (its plan), its
// tab and Home's list, even while the server lists it as the user's.
test("a thread's composer shows its manager's own questions, not a question its worker asks", () => {
  const own = { id: "q_1", question: "Ship it on Friday?", options: [], askedAt: at };
  act(() => {
    useManagerThreadsStore.getState().replaceAll([managerThreadDto("thr_a", { title: "project-1 release", questions: [own] })]);
    useProjectsStore.getState().setProjectsState([clientProject("p1", { workers: [clientWorker("evict", { ownerThreadId: "thr_a" })] })]);
    useWorkerPlansStore.getState().upsert({ ...emptyPlan("evict"), openQuestions: ["Keep the old flag as an alias?"], updatedAt: at }, "fetch");
  });
  const { host } = mount(<Questions />);
  expect(host.textContent).toBe("Ship it on Friday?");
  act(() => useThreadStatusStore.getState().replace({ threads: [], waiting: [asking("thr_a")] }));
  expect(host.textContent).toBe("Ship it on Friday?");
});

function Tone({ workerId }: { workerId: string }) {
  return <span>{useWorkerQuestionTone(workerId)}</span>;
}

test("a worker's question is the user's exactly while the server lists it", () => {
  const { host } = mount(<Tone workerId="evict" />);
  expect(host.textContent).toBe("manager");
  act(() => useThreadStatusStore.getState().replace({ threads: [], waiting: [asking("thr_a")] }));
  expect(host.textContent).toBe("user");
});
