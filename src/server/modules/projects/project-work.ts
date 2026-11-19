import { createKeyedExclusion } from "../../platform/process/keyed-exclusion.js";

/**
 * Work that reads a project's git or tmux state and then changes its workers
 * (making, archiving or restoring one, moving the project's folder) runs one
 * at a time per project, by project id. git and tmux answer while the server
 * goes on, so two such requests would otherwise act on each other's stale
 * answers: two workers given one window name, an archive's hook run twice, a
 * folder change that never saw a worker made meanwhile. One for the whole
 * process: every service instance shares it. Not re-entrant: work holding a
 * project never asks for it again.
 */
export const projectWork = createKeyedExclusion();

/**
 * Work that closes a tmux session runs one at a time per session name. Taken
 * inside a project's turn (an archive closing its session), never the other
 * way round, so the two never wait on each other.
 */
export const sessionWork = createKeyedExclusion();
