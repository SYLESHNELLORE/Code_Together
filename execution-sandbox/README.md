# Execution sandbox image

Builds the hardened container that the API uses for `EXECUTION_RUNNER=docker`.
Every language it supports runs inside one image with:

- `--network none`, `--read-only`, non-root `--user 10001:10001`
- `--cap-drop ALL`, `no-new-privileges`, memory/CPU/PID limits, `ulimit core=0`
- a size-limited, `noexec` writable `tmpfs` at `/tmp` for source/scratch files
  and a separate size-limited `exec` writable `tmpfs` at `/work` used only for
  compiled C/C++ binaries
- no host bind mounts, devices, Docker socket or application environment
  variables; source code arrives through stdin

## Build

From the repository root:

```bash
docker build -t codetogether-executor:latest execution-sandbox
```

Then set `EXECUTION_RUNNER=docker` in `server/.env` and restart the API.
`GET /api/projects/:id/executions/capabilities` reports whether the image is
actually available.

## Supported languages and entrypoints (`run-code`)

| Language | Entry name | Runner |
| --- | --- | --- |
| Python | `main.py` | `python3 -I -B` |
| JavaScript | `main.js` | `node` |
| TypeScript / TSX | `main.ts` / `main.tsx` | `tsx` (transpiled, not type-checked) |
| C | `main.c` | `gcc -O1 -std=c17` |
| C++ | `main.cpp` | `g++ -O1 -std=c++17` |
| Java | `main.java` | `java main.java` (JEP 330 single-file launcher) |

The entrypoint re-validates the language and entry name, caps input at 200 KB,
and exits `64` on anything unexpected. Rebuild the image after editing
`run-code` or `Dockerfile`; the API keeps running the previously built image
until then.
