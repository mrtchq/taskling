# Taskling MCP mode

Taskling ships an MCP server mode in the fork (`src/mcp/server.ts`, reached
via `taskling mcp`). It exposes exactly three tools — per-agent tools are a
later Phase 2 option and are intentionally out of scope here:

| Tool | What it does |
|---|---|
| `list_agents` | Lists agent configs in the agents directory: `id`, `name`, `model`, `file`. |
| `run_agent` | Starts a run for `agentId` with optional `input`. Waits with progress up to `waitMs` (default 120,000 ms, max 300,000 ms). If the run finishes inside the wait, the full result is returned. If it is still running when the wait expires, the response carries `status: "running"` and the `runId` — fetch the outcome later with `get_agent_run`. A run that fails inside the wait is returned with `isError: true` and still carries its `runId`. |
| `get_agent_run` | Fetches a run record by `runId`: `status` (`running` / `completed` / `failed`), progress lines (plan steps and tool calls), `result`, or `error`, plus timestamps. |

## Agent registry

Agents come from JSON files in the agents directory:

- Default: `./agents/` (relative to the working directory), or set
  `TASKLING_AGENTS_DIR`, or pass `taskling mcp --agents-dir <dir>`.
- Each `*.json` file is either a full Taskling CLI config
  (`{ llmProviders, integrations, maxSteps, agent: {...} }`) or an
  agent-only config (`{ name, model, instructions, ... }`).
- The agent ID is the file name without `.json`
  (e.g. `agents/researcher.json` → `researcher`).
- Invalid files are skipped with a warning on stderr; they never break
  `list_agents` for the valid ones.
- Runs live in memory only for the life of the server process. Restarting
  the server discards run IDs — durable run history belongs to the control
  layer, not this standalone fork.

## Transports

### stdio (default)

```bash
taskling mcp
taskling mcp --agents-dir ./agents
```

Newline-delimited JSON-RPC on stdin/stdout. All server logging goes to
stderr so stdout stays clean for the protocol. stdio trusts the local
caller (the usual MCP convention) and needs no token.

### Streamable HTTP (token-gated)

```bash
export TASKLING_MCP_TOKEN="a-long-random-token"
taskling mcp --http --port 3000            # binds 127.0.0.1 by default
```

- The server **refuses to start** HTTP mode unless `TASKLING_MCP_TOKEN`
  is set. Never pass the token as a CLI argument (it would show in the
  process list); the environment variable is the only input.
- Every `POST /mcp` request must carry
  `Authorization: Bearer <token>` or it gets HTTP 401. The token is
  compared in constant time and never logged.
- `POST /mcp` takes a single JSON-RPC request object (batches are
  rejected). If the client sends `Accept: text/event-stream`, the response
  is wrapped in a single SSE `message` event; otherwise it is plain JSON.
- `GET /health` is an unauthenticated liveness check (`{ ok: true }`).
  `GET /mcp` returns 405 — this server does not hold an SSE stream open.

Example (token in the environment, dummy value shown):

```bash
curl -s http://127.0.0.1:3000/mcp \
  -H "Authorization: Bearer $TASKLING_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## What is NOT here yet

- No per-agent MCP tools (`run_<agent>` style) — later option only.
- No authentication beyond the single bearer token, no per-customer
  isolation, no billing/metering — those belong to later Phase 2 work.
- No live LLM run is required to verify this mode: a run against an
  agent with no provider key fails fast with a provider error surfaced
  through `get_agent_run`, which proves the whole
  start → wait → fetch path without spending anything.
