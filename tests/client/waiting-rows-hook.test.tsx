import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { useWaitingRows } from "@/hooks/useWaitingRows";
import { useHomeAttention } from "@/hooks/useAttentionCount";
import { useThreadStatusStore } from "@/store/thread-status";
import { usePersonalAgentStore } from "@/store/personal-agent";
import type { PersonalAgentDto } from "@shared/api/personal-agent";
import { runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";
import { stub } from "../helpers/typed.js";

afterEach(() => {
  runCleanups();
  act(() => {
    useThreadStatusStore.getState().replace({ threads: [], waiting: [] });
    usePersonalAgentStore.setState({ agent: null });
  });
});

function Probe() {
  const rows = useWaitingRows();
  const { count } = useHomeAttention();
  return <p data-count={count}>{rows.map((row) => `${row.title}: ${row.text}`).join(" | ")}</p>;
}

// The status can arrive before the personal agent's own row has loaded (or that read
// can fail): what the server lists still counts, under the name the page
// gives the personal agent until it has one.
test("The personal agent's question is a row, and counted, before its name has loaded", () => {
  act(() => useThreadStatusStore.getState().replace({ threads: [], waiting: [
    { key: "agent:agent:input", kind: "agent", waiting: "input", threadId: null, threadTitle: null, workerId: null, workerName: null, text: "Send the weekly summary now?", place: null }
  ] }));
  const { host } = mount(<Probe />);
  const p = host.querySelector("p")!;
  expect([p.textContent, p.getAttribute("data-count")]).toEqual(["Personal agent: Send the weekly summary now?", "1"]);
  act(() => usePersonalAgentStore.setState({ agent: stub<PersonalAgentDto>({ name: "Juno", named: true }) }));
  expect(p.textContent).toBe("Juno: Send the weekly summary now?");
});
