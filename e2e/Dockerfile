# Image for the e2e tier. Everything a test here is allowed to depend on has
# to be installed explicitly, which is the point: the list below IS the
# declared external environment, and anything missing from it fails loudly
# instead of silently working on whoever's laptop happens to have it.
#
# Deliberately absent: netcat. Terminal streaming used to shell out to
# `nc -U`, and an image without it is what proves the dependency is gone.
FROM oven/bun:1.4.2-debian

# tmux — pinned, because pipe-pane and capture-pane semantics have moved
#        between releases and a drifting version turns into a drifting test.
# git   — the worktree and diff tests drive a real repository.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux \
      git \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && tmux -V

WORKDIR /app

# Dependencies before sources, so editing a test does not reinstall anything.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Chromium and the system libraries it needs. Its own layer, above the source
# copy, so editing a test does not re-download a browser. Chromium only: the
# tests here are about whether our layout holds, not about engine differences.
RUN bunx playwright install --with-deps chromium

COPY . .

# The e2e tier drives the shipped artefact, not the sources: the binary serves
# its client from a map embedded here at compile time, while a source run falls
# back to serveStatic on disk. Building it costs about ten seconds.
RUN bun run build:binary

CMD ["bun", "run", "test:e2e:run"]
