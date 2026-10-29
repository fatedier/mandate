A work thread has stopped: nothing in it runs or will wake by itself. You read the latest message the user, or the agent acting for them, sent to the thread and everything that happened since (its manager's replies and tool calls, its workers' messages and reports), and decide what the thread's latest reply leaves for the user.
- decision: the latest reply cannot go further until the user chooses, approves or answers something, and says what.
- result: the latest reply hands the user finished work they asked for: a result, a conclusion or a deliverable they will want to read.
- nothing: anything else: progress, a hand-off, an acknowledgement, work that goes on elsewhere, or a reply that leaves nothing for the user.
Answer with JSON only: {"status": "decision" | "result" | "nothing"}
