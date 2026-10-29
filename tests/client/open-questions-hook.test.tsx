import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { useOpenQuestions } from "@/hooks/useOpenQuestions";
import { useWorkerQuestionTone } from "@/hooks/useWorkerQuestionTone";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useProjectsStore } from "@/store/projects";
import { useFeaturePlansStore } from "@/store/feature-plans";
import { useThreadStatusStore } from "@/store/thread-status";
import { emptyPlan } from "@shared/api/plans";
import type { WaitingEntryDto } from "@shared/api/thread-status";
import { runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";
import { clientFeature, clientProject, managerThreadDto } from "../helpers/client-builders.js";

const at = "2026-09-27T00:00:00.000Z";

afterEach(() => {
  runCleanups();
  act(() => {
    useManagerThreadsStore.setState({ threads: new Map(), loaded: false });
    useProjectsStore.getState().setProjectsState([]);
    useFeaturePlansStore.setState({ plans: new Map() });
    useThreadStatusStore.getState().replace({ threads: [], waiting: [] });
  });
});

function Questions() {
  const shown = useOpenQuestions({ type: "manager", threadId: "thr_a" });
  return <ul>{shown.map((q) => <li key={q.id}>{q.question}</li>)}</ul>;
}

const asking = (threadId: string): WaitingEntryDto => ({
  key: "worker:evict:input", kind: "worker", waiting: "input", threadId, threadTitle: "project-1 release",
  featureId: "evict", workerName: "evict", text: "Keep the old flag as an alias?", place: null
});

// A worker's question stands above its thread's composer exactly while the
// server lists it as the user's (its thread rests; the rule is the server's).
test("a thread's composer shows its worker's question while the server lists it as the user's", () => {
  act(() => {
    useManagerThreadsStore.getState().replaceAll([managerThreadDto("thr_a", { title: "project-1 release" })]);
    useProjectsStore.getState().setProjectsState([clientProject("p1", { features: [clientFeature("evict", { ownerThreadId: "thr_a" })] })]);
    useFeaturePlansStore.getState().upsert({ ...emptyPlan("evict"), openQuestions: ["Keep the old flag as an alias?"], updatedAt: at }, "fetch");
  });
  const { host } = mount(<Questions />);
  expect(host.textContent).toBe("");
  act(() => useThreadStatusStore.getState().replace({ threads: [], waiting: [asking("thr_a")] }));
  expect(host.textContent).toBe("Keep the old flag as an alias?");
  // Listed for another thread: not this one's.
  act(() => useThreadStatusStore.getState().replace({ threads: [], waiting: [asking("thr_b")] }));
  expect(host.textContent).toBe("");
});

function Tone({ featureId }: { featureId: string }) {
  return <span>{useWorkerQuestionTone(featureId)}</span>;
}

test("a worker's question is the user's exactly while the server lists it", () => {
  const { host } = mount(<Tone featureId="evict" />);
  expect(host.textContent).toBe("manager");
  act(() => useThreadStatusStore.getState().replace({ threads: [], waiting: [asking("thr_a")] }));
  expect(host.textContent).toBe("user");
});
