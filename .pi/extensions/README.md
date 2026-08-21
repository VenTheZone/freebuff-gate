# Project-local Pi extensions (dynamic, not bundled)

Drop any `.ts` extension here. Pi auto-discovers `*.ts` and `*/index.ts` from
this directory on every session start and `/reload` — no sync/copy into the
global bundle (`~/.pi/agent/extensions/`) required.

The freebuff-gate desktop bridge launches Pi with `--approve`, which grants
project trust, so extensions here load automatically.

- New file → `/reload` (or restart Pi) to pick it up.
- Subdirectory extension → name the entry `index.ts`.
- A load error in any extension makes Pi exit(1); fix the file and reload.
