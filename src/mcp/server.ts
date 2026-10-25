/**
 * @module mcp/server
 * Taskling MCP server mode.
 *
 * Exposes exactly three tools (per-agent tools are a later Phase 2 option and
 * are intentionally NOT built here):
 *   - list_agents  : list agent configs found in the agents directory.
 *   - run_agent    : start an agent run; wait with progress up to `waitMs`
 *                    (default 120s, max 300s), then return the run ID so the
 *                    client can poll it with get_agent_run.
 *   - get_agent_run: fetch a run record (status, progress, result, error).
 *
 * Transports:
 *   - stdio: newline-delimited JSON-RPC on stdin/stdout. All logging goes to
 *     stderr so stdout stays clean for the protocol. Local-process trust:
 *     no token is required on stdio (same convention as other MCP servers).
 *   - streamable HTTP: POST /mcp with a single JSON-RPC request. Token-gated:
 *     the server REFUSES to start HTTP mode unless TASKLING_MCP_TOKEN is set,
 *     and every request must carry `Authorization: Bearer <token>`. The
 *     token is never logged. Binds 127.0.0.1 by default; pass --host only
 *     deliberately. GET /health is an unauthenticated liveness check that
 *     reveals nothing else. If the client sends
 *     `Accept: text/event-stream`, the JSON-RPC response is wrapped in a
 *     single SSE `message` event; otherwise it is plain JSON.
 *
 * Agent registry: TASKLING_AGENTS_DIR (default ./agents, relative to the
 * working directory). Each *.json file is either a full Taskling CLI config
 * ({ llmProviders, integrations, maxSteps, agent: {...} }) or an agent-only
 * config ({ name, model, instructions, ... }). The agent ID is the file name
 * without .json. Runs are kept in memory only for the life of the server
 * process; restart the server and run IDs are gone (by design for this
 * standalone fork — durable run history belongs to the control layer).
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename, resolve } from 'path';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { createInterface } from 'readline';
import { randomUUID, timingSafeEqual } from 'crypto';
import type { AgentConfig } from '../types/index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface McpAgentRecord {
	id: string;
	name: string;
	model: string;
	file: string;
	/** Parsed file contents (full CLI config or agent-only config). */
	raw: Record<string, unknown>;
}

export type RunStatus = 'running' | 'completed' | 'failed';

export interface RunRecord {
	runId: string;
	agentId: string;
	status: RunStatus;
	input: unknown;
	progress: string[];
	result: unknown | null;
	error: string | null;
	startedAt: string;
	finishedAt: string | null;
}

interface JsonRpcRequest {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown> & { _meta?: { progressToken?: string | number } };
}

interface JsonRpcResponse {
	jsonrpc: '2.0';
	id: string | number | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

type Notify = (msg: Record<string, unknown>) => void;

// ─── Agent registry ───────────────────────────────────────────────────────────

function asAgentConfig(raw: Record<string, unknown>): AgentConfig | null {
	const agent = (raw.agent as Record<string, unknown> | undefined) ?? raw;
	if (typeof agent.name !== 'string' || agent.name.length === 0) return null;
	if (typeof agent.model !== 'string' || agent.model.length === 0) return null;
	return agent as unknown as AgentConfig;
}

export function loadAgents(agentsDir: string): McpAgentRecord[] {
	const dir = resolve(agentsDir);
	if (!existsSync(dir)) return [];
	const out: McpAgentRecord[] = [];
	for (const file of readdirSync(dir).sort()) {
		if (!file.endsWith('.json')) continue;
		try {
			const raw = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as Record<string, unknown>;
			const agent = asAgentConfig(raw);
			if (!agent) {
				console.error(`[taskling-mcp] skipping ${file}: no agent.name/model`);
				continue;
			}
			out.push({ id: basename(file, '.json'), name: agent.name, model: agent.model, file, raw });
		} catch (err) {
			console.error(`[taskling-mcp] skipping ${file}: ${String(err)}`);
		}
	}
	return out;
}

// ─── Run store + execution ────────────────────────────────────────────────────

const MAX_PROGRESS = 200;

function pushProgress(rec: RunRecord, line: string): void {
	rec.progress.push(line);
	if (rec.progress.length > MAX_PROGRESS) rec.progress.splice(0, rec.progress.length - MAX_PROGRESS);
}

async function executeRun(rec: RunRecord, agent: McpAgentRecord): Promise<void> {
	const raw = agent.raw;
	const top = (raw.agent as Record<string, unknown> | undefined) ?? {};
	const agentCfg = asAgentConfig(raw);
	if (!agentCfg) {
		rec.status = 'failed';
		rec.error = 'Agent config has no name/model';
		rec.finishedAt = new Date().toISOString();
		return;
	}
	try {
		// Lazy import: keeps --help / list paths from loading every integration.
		const { OpenMolt } = await import('../OpenMolt.js');
		const om = new OpenMolt({
			llmProviders: (raw.llmProviders as never) ?? (top.llmProviders as never),
			integrations: (raw.integrations as never) ?? (top.integrations as never),
			maxSteps: (raw.maxSteps as number | undefined) ?? (top.maxSteps as number | undefined),
			verbose: false,
		});
		const instance = om.createAgent(agentCfg);
		instance.on('planUpdate', (e) => {
			const active = e.plan.find((s) => s.status === 'inProgress');
			if (active) pushProgress(rec, `plan: ${active.name}`);
		});
		instance.on('tool:call', (e) => {
			pushProgress(rec, `tool: ${e.tool.integration}.${e.tool.handle}`);
		});
		instance.on('finish', () => {
			pushProgress(rec, 'finish');
		});
		const result = await instance.run(rec.input);
		rec.result = result;
		rec.status = 'completed';
	} catch (err) {
		rec.status = 'failed';
		rec.error = String(err);
	} finally {
		rec.finishedAt = new Date().toISOString();
	}
}

export class RunStore {
	private runs = new Map<string, RunRecord>();

	start(agent: McpAgentRecord, input: unknown): RunRecord {
		const rec: RunRecord = {
			runId: randomUUID(),
			agentId: agent.id,
			status: 'running',
			input: input ?? null,
			progress: [],
			result: null,
			error: null,
			startedAt: new Date().toISOString(),
			finishedAt: null,
		};
		this.runs.set(rec.runId, rec);
		// Fire-and-forget by design: run_agent waits on the record, and
		// get_agent_run can fetch it after the wait expires.
		void executeRun(rec, agent);
		return rec;
	}

	get(runId: string): RunRecord | undefined {
		return this.runs.get(runId);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function waitForRun(rec: RunRecord, waitMs: number, notify?: Notify, progressToken?: string | number): Promise<void> {
	const deadline = Date.now() + waitMs;
	let seen = 0;
	while (rec.status === 'running' && Date.now() < deadline) {
		if (notify && progressToken !== undefined && rec.progress.length > seen) {
			for (const line of rec.progress.slice(seen)) {
				notify({
					jsonrpc: '2.0',
					method: 'notifications/progress',
					params: { progressToken, progress: rec.progress.length, message: line },
				});
			}
			seen = rec.progress.length;
		}
		await sleep(250);
	}
}

function publicRun(rec: RunRecord): RunRecord {
	return { ...rec, progress: [...rec.progress] };
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
	{
		name: 'list_agents',
		description: 'List Taskling agents available in the agents directory (id, name, model).',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	},
	{
		name: 'run_agent',
		description:
			'Start an agent run. Waits with progress up to waitMs (default 120000, max 300000). ' +
			'If the run is still going when the wait expires, returns its runId with status "running"; ' +
			'fetch the outcome later with get_agent_run.',
		inputSchema: {
			type: 'object',
			properties: {
				agentId: { type: 'string', description: 'Agent ID from list_agents (config file name without .json).' },
				input: { description: 'Initial input for the agent (string, object, or null).' },
				waitMs: { type: 'number', description: 'How long to wait for completion before returning the runId (0-300000, default 120000).' },
			},
			required: ['agentId'],
			additionalProperties: false,
		},
	},
	{
		name: 'get_agent_run',
		description: 'Fetch a run record by runId: status, progress lines, result, or error.',
		inputSchema: {
			type: 'object',
			properties: { runId: { type: 'string' } },
			required: ['runId'],
			additionalProperties: false,
		},
	},
];

function textResult(payload: unknown, isError = false): Record<string, unknown> {
	return {
		content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
		...(isError ? { isError: true } : {}),
	};
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
	return { jsonrpc: '2.0', id, error: { code, message } };
}

function rpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
	return { jsonrpc: '2.0', id, result };
}

// ─── JSON-RPC handler ─────────────────────────────────────────────────────────

/** One handler instance serves one transport; agents are loaded once at start. */
export function createMcpHandler(agentsDir: string): {
	handler: (req: JsonRpcRequest, notify?: Notify) => Promise<JsonRpcResponse | null>;
	store: RunStore;
	agents: McpAgentRecord[];
} {
	const agents = loadAgents(agentsDir);
	const store = new RunStore();
	const byId = new Map(agents.map((a) => [a.id, a]));

	async function handler(req: JsonRpcRequest, notify?: Notify): Promise<JsonRpcResponse | null> {
		const id = req.id ?? null;
		const isNotification = req.id === undefined || req.id === null;
		if (typeof req.method !== 'string') {
			return isNotification ? null : rpcError(id, -32600, 'Invalid Request: missing method');
		}
		switch (req.method) {
			case 'initialize': {
				const requested = typeof req.params?.protocolVersion === 'string' ? (req.params.protocolVersion as string) : '2024-11-05';
				return rpcResult(id, {
					protocolVersion: requested,
					capabilities: { tools: {} },
					serverInfo: { name: 'taskling', version: '0.1.8' },
				});
			}
			case 'notifications/initialized':
			case 'notifications/cancelled':
				return null;
			case 'ping':
				return rpcResult(id, {});
			case 'tools/list':
				return rpcResult(id, { tools: TOOLS });
			case 'tools/call': {
				const params = (req.params ?? {}) as { name?: unknown; arguments?: Record<string, unknown> };
				const name = params.name;
				const args = params.arguments ?? {};
				if (name === 'list_agents') {
					return rpcResult(id, textResult({
						agents: agents.map((a) => ({ id: a.id, name: a.name, model: a.model, file: a.file })),
					}));
				}
				if (name === 'run_agent') {
					const agentId = args.agentId;
					if (typeof agentId !== 'string' || agentId.length === 0) {
						return rpcError(id, -32602, 'run_agent requires a non-empty string agentId');
					}
					const agent = byId.get(agentId);
					if (!agent) {
						return rpcError(id, -32602, `Unknown agentId: ${agentId}`);
					}
					const rawWait = typeof args.waitMs === 'number' ? args.waitMs : 120000;
					const waitMs = Math.max(0, Math.min(300000, Math.floor(rawWait)));
					const rec = store.start(agent, args.input ?? null);
					const progressToken = req.params?._meta?.progressToken;
					await waitForRun(rec, waitMs, notify, progressToken);
					const payload = publicRun(rec);
					if (rec.status === 'failed') {
						return rpcResult(id, textResult(payload, true));
					}
					return rpcResult(id, textResult(payload));
				}
				if (name === 'get_agent_run') {
					const runId = args.runId;
					if (typeof runId !== 'string' || runId.length === 0) {
						return rpcError(id, -32602, 'get_agent_run requires a non-empty string runId');
					}
					const rec = store.get(runId);
					if (!rec) {
						return rpcError(id, -32602, `Unknown runId: ${runId}`);
					}
					return rpcResult(id, textResult(publicRun(rec)));
				}
				return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
			}
			default:
				return isNotification ? null : rpcError(id, -32601, `Method not found: ${req.method}`);
		}
	}

	return { handler, store, agents };
}

// ─── stdio transport ──────────────────────────────────────────────────────────

export async function startStdioServer(agentsDir: string): Promise<void> {
	// Protocol correctness: the library logger writes to stdout (console.info),
	// which would corrupt the newline-delimited JSON-RPC stream. Silence it
	// for stdio mode; run progress is still reported via MCP progress
	// notifications and the run record. (HTTP mode keeps logging: its stdout
	// is not a protocol channel.)
	const { logger } = await import('../utils/logger.js');
	logger.setLevel('silent');
	const { handler } = createMcpHandler(agentsDir);
	console.error(`[taskling-mcp] stdio server started, agentsDir=${resolve(agentsDir)}`);
	const rl = createInterface({ input: process.stdin, terminal: false });
	const notify: Notify = (msg) => {
		process.stdout.write(`${JSON.stringify(msg)}\n`);
	};
	for await (const line of rl) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let req: JsonRpcRequest;
		try {
			req = JSON.parse(trimmed) as JsonRpcRequest;
		} catch {
			process.stdout.write(`${JSON.stringify(rpcError(null, -32700, 'Parse error'))}\n`);
			continue;
		}
		try {
			const res = await handler(req, notify);
			if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
		} catch (err) {
			const res = rpcError(req.id ?? null, -32603, `Internal error: ${String(err)}`);
			process.stdout.write(`${JSON.stringify(res)}\n`);
		}
	}
}

// ─── Streamable HTTP transport ────────────────────────────────────────────────

function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<string> {
	return new Promise((resolveBody, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error('Request body too large'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf-8')));
		req.on('error', reject);
	});
}

function authOk(req: IncomingMessage, expected: string): boolean {
	const header = req.headers.authorization ?? '';
	if (!header.startsWith('Bearer ')) return false;
	const provided = header.slice('Bearer '.length);
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

export async function startHttpServer(opts: { agentsDir: string; host: string; port: number }): Promise<void> {
	const token = process.env.TASKLING_MCP_TOKEN;
	if (!token) {
		throw new Error('HTTP mode refuses to start without TASKLING_MCP_TOKEN set (token-gated by design; stdio mode needs no token).');
	}
	const { handler } = createMcpHandler(opts.agentsDir);
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		try {
			const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
			if (req.method === 'GET' && url.pathname === '/health') {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ ok: true, service: 'taskling-mcp' }));
				return;
			}
			if (url.pathname !== '/mcp') {
				res.writeHead(404, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ error: 'not found' }));
				return;
			}
			if (req.method === 'GET') {
				res.writeHead(405, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ error: 'GET /mcp stream not supported; POST a JSON-RPC request' }));
				return;
			}
			if (req.method !== 'POST') {
				res.writeHead(405, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ error: 'method not allowed' }));
				return;
			}
			if (!authOk(req, token)) {
				res.writeHead(401, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized: Bearer token required' } }));
				return;
			}
			let parsed: JsonRpcRequest;
			try {
				parsed = JSON.parse(await readBody(req)) as JsonRpcRequest;
			} catch {
				res.writeHead(400, { 'content-type': 'application/json' });
				res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')));
				return;
			}
			if (Array.isArray(parsed) || typeof parsed !== 'object' || parsed === null) {
				res.writeHead(400, { 'content-type': 'application/json' });
				res.end(JSON.stringify(rpcError(null, -32600, 'Invalid Request: single JSON-RPC object expected')));
				return;
			}
			const result = await handler(parsed);
			if (!result) {
				res.writeHead(202, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ accepted: true }));
				return;
			}
			const accept = req.headers.accept ?? '';
			if (accept.includes('text/event-stream')) {
				res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
				res.end(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
				return;
			}
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify(result));
		} catch (err) {
			console.error(`[taskling-mcp] http error: ${String(err)}`);
			if (!res.headersSent) {
				res.writeHead(500, { 'content-type': 'application/json' });
			}
			res.end(JSON.stringify(rpcError(null, -32603, 'Internal error')));
		}
	});
	await new Promise<void>((resolveListen, reject) => {
		server.once('error', reject);
		server.listen(opts.port, opts.host, () => resolveListen());
	});
	console.error(`[taskling-mcp] HTTP server listening on http://${opts.host}:${opts.port}/mcp (token-gated, loopback by default)`);
	// Keep process alive until killed; the http server holds the event loop.
	await new Promise(() => {});
}
