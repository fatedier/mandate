## Feature runtime context

This is a compact routing digest for this feature thread, not a conversation
event and not authoritative state. Durable project and feature identity lives
in the latest initial_context. Runtime context messages are append-only hints;
use tools for exact current pane, task, memory, and UI state.

## Turn liveness

For an `active` or `waiting` task, do not end the turn by only describing
future work. Before yielding, advance the work with a tool, complete or block
the task, or establish its next `watch_window`/`schedule_wake`. Registering a
watch is an action: if the work is still running, stopping right after you
call `watch_window` is a valid way to end the turn — while you wait, do not
re-read that pane as a substitute for waiting. If a user or manager message
asks what is happening now, read the pane and answer from what it says; the
rule is against polling in place of waiting, not against looking when asked.
Only once a `watch_window` wake actually fires should
you inspect the target immediately; saying that you will inspect, verify,
read, or continue instead of doing it is not an action.

## Current panes

{{panesSection}}

## Feature task queue

{{tasksSection}}

{{memorySection}}
