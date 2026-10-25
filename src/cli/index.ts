#!/usr/bin/env node
/**
 * @module cli
 * Taskling CLI – spawn a Taskling, run it from a config file, or serve it
 * over MCP.
 *
 * Fork of OpenMolt's CLI, rebranded to Taskling. The library class is still
 * exported as both `Taskling` and `OpenMolt` (see src/index.ts); this CLI
 * only ever presents the Taskling name.
 *
 * Usage:
 *   taskling init [dir] [--force]        Scaffold a taskling.config.json
 *   taskling deploy [configFile]         Validate a config for deployment
 *   taskling mcp [--http] [--port N] [--host H] [--agents-dir D]
 *                                        Serve MCP tools over stdio (default)
 *                                        or token-gated streamable HTTP
 *   taskling <configFile> [options]      Run one agent from a JSON/JS config
 *   taskling                             Run ./taskling.config.json if present
 *   taskling --help
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, extname, join } from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

// Load .env file if present
try {
	const { config } = await import('dotenv');
	config();
} catch { /* dotenv optional */ }

// ─── Help ─────────────────────────────────────────────────────────────────────

function printHelp(): void {
	console.log(`
Taskling – Spawn a Taskling. Tiny, tireless agents that get work done.
Usage: taskling <command|configFile> [options]

Commands:
  init [dir] [--force]   Scaffold a taskling.config.json in [dir] (default: .)
  deploy [configFile]    Validate a config for deployment (default: taskling.config.json)
  mcp [options]          Serve MCP tools (list_agents, run_agent, get_agent_run)
                         over stdio by default, or streamable HTTP with --http.
                         HTTP is token-gated: set TASKLING_MCP_TOKEN first.
  <configFile>           Run one agent from a JSON or JS/MJS config file.
                         With no argument, ./taskling.config.json is used if present.

Run options:
  --input <str>  Initial input to pass to the agent's run() method.
  --dry-run      Parse and validate config without running the agent.
  --verbose      Enable verbose logging.
  --help         Show this help message.

MCP options:
  --http             Serve streamable HTTP instead of stdio.
  --port <n>         HTTP port (default: 3000).
  --host <h>         HTTP host (default: 127.0.0.1 — loopback only).
  --agents-dir <d>   Directory of agent *.json configs (default: ./agents,
                     or TASKLING_AGENTS_DIR).

Config file format (JSON):
  {
    "llmProviders": {
      "openai":    { "apiKey": "..." },
      "anthropic": { "apiKey": "..." },
      "google":    { "apiKey": "..." }
    },
    "integrations": { ... },
    "maxSteps": 20,
    "verbose": false,
    "agent": {
      "name": "My Taskling",
      "model": "openai:gpt-4o",
      "instructions": "...",
      "integrations": [ ... ],
      "schedules": [ ... ]
    },
    "input": "Initial task input"
  }

API keys can also be provided via environment variables:
  TASKLING_OPENAI_API_KEY, TASKLING_ANTHROPIC_API_KEY, TASKLING_GOOGLE_API_KEY
  (OPENMOLT_* names are still honoured as a fallback.)
`);
}

const SCAFFOLD = `{
  "llmProviders": {},
  "maxSteps": 20,
  "verbose": false,
  "agent": {
    "name": "my-taskling",
    "model": "openai:gpt-4o",
    "instructions": "You are a helpful Taskling. Complete the task given as input."
  },
  "input": "Say hello and describe what you can do in one sentence."
}
`;

// ─── Arg parsing ──────────────────────────────────────────────────────────────

interface CliArgs {
	command: 'init' | 'deploy' | 'mcp' | 'run' | 'help';
	configPath: string | null;
	dir: string | null;
	input: string | null;
	dryRun: boolean;
	verbose: boolean;
	help: boolean;
	force: boolean;
	http: boolean;
	port: number;
	host: string;
	agentsDir: string | null;
}

function parseArgs(argv: string[]): CliArgs {
	const args = argv.slice(2);
	const result: CliArgs = {
		command: 'run',
		configPath: null,
		dir: null,
		input: null,
		dryRun: false,
		verbose: false,
		help: false,
		force: false,
		http: false,
		port: 3000,
		host: '127.0.0.1',
		agentsDir: null,
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--help' || arg === '-h') {
			result.help = true;
		} else if (arg === '--dry-run') {
			result.dryRun = true;
		} else if (arg === '--verbose') {
			result.verbose = true;
		} else if (arg === '--force') {
			result.force = true;
		} else if (arg === '--http') {
			result.http = true;
		} else if (arg === '--input' || arg === '-i') {
			result.input = args[++i] ?? null;
		} else if (arg === '--port') {
			result.port = Number(args[++i] ?? 3000);
		} else if (arg === '--host') {
			result.host = args[++i] ?? '127.0.0.1';
		} else if (arg === '--agents-dir') {
			result.agentsDir = args[++i] ?? null;
		} else if (arg === 'init' && result.command === 'run' && !result.configPath) {
			result.command = 'init';
		} else if (arg === 'deploy' && result.command === 'run' && !result.configPath) {
			result.command = 'deploy';
		} else if (arg === 'mcp' && result.command === 'run' && !result.configPath) {
			result.command = 'mcp';
		} else if (!arg.startsWith('--')) {
			if (result.command === 'init') {
				result.dir = arg;
			} else if (result.command === 'deploy' || result.command === 'run') {
				result.configPath = arg;
			}
		}
	}
	return result;
}

// ─── Config loading ───────────────────────────────────────────────────────────

interface AgentCliConfig {
	llmProviders?: Record<string, { apiKey?: string }>;
	integrations?: Record<string, Record<string, unknown>>;
	maxSteps?: number;
	verbose?: boolean;
	agent: {
		name: string;
		model: string;
		instructions?: string;
		instructionsPath?: string;
		modelConfig?: Record<string, unknown>;
		integrations?: unknown[];
		memory?: unknown;
		outputSchema?: unknown;
		schedules?: unknown[];
	};
	input?: unknown;
}

async function loadConfig(configPath: string): Promise<AgentCliConfig> {
	const absPath = resolve(configPath);
	if (!existsSync(absPath)) {
		throw new Error(`Config file not found: ${absPath}`);
	}
	const ext = extname(absPath).toLowerCase();
	if (ext === '.json') {
		const raw = readFileSync(absPath, 'utf-8');
		return JSON.parse(raw) as AgentCliConfig;
	}
	if (ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.ts') {
		try {
			const fileUrl = pathToFileURL(absPath).href;
			const mod = await import(fileUrl);
			return (mod.default ?? mod) as AgentCliConfig;
		} catch {
			const req = createRequire(import.meta.url);
			return req(absPath) as AgentCliConfig;
		}
	}
	throw new Error(`Unsupported config file type: ${ext}. Use .json, .js, or .mjs`);
}

function validateAgentConfig(config: AgentCliConfig, source: string): void {
	if (!config.agent) {
		throw new Error(`Config file must contain an "agent" property (${source}).`);
	}
	if (typeof config.agent.name !== 'string' || config.agent.name.length === 0) {
		throw new Error(`Config agent.name must be a non-empty string (${source}).`);
	}
	if (typeof config.agent.model !== 'string' || config.agent.model.length === 0) {
		throw new Error(`Config agent.model must be a non-empty string like "openai:gpt-4o" (${source}).`);
	}
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdInit(args: CliArgs): Promise<void> {
	const dir = resolve(args.dir ?? '.');
	const target = join(dir, 'taskling.config.json');
	if (existsSync(target) && !args.force) {
		console.error(`taskling.config.json already exists at ${target} (use --force to overwrite).`);
		process.exit(1);
	}
	mkdirSync(dir, { recursive: true });
	writeFileSync(target, SCAFFOLD, 'utf-8');
	console.log(`Spawned a Taskling scaffold at ${target}`);
	console.log('Next steps:');
	console.log('  1. Set TASKLING_OPENAI_API_KEY (or anthropic/google) in .env');
	console.log('  2. Edit the agent name, model, and instructions in taskling.config.json');
	console.log('  3. Validate: taskling taskling.config.json --dry-run');
	console.log('  4. Run:     taskling taskling.config.json');
	console.log('  5. Serve:   taskling mcp  (put agent configs in ./agents/ first)');
}

async function cmdDeploy(args: CliArgs): Promise<void> {
	const source = args.configPath ?? 'taskling.config.json';
	let config: AgentCliConfig;
	try {
		config = await loadConfig(source);
		validateAgentConfig(config, source);
	} catch (err) {
		console.error(`Deploy check FAILED: ${String(err)}`);
		process.exit(1);
	}
	const integrations = Array.isArray(config.agent.integrations) ? config.agent.integrations.length : 0;
	const schedules = Array.isArray(config.agent.schedules) ? config.agent.schedules.length : 0;
	console.log('Deploy check PASSED (local validation only):');
	console.log(JSON.stringify({
		config: resolve(source),
		agent: config.agent.name,
		model: config.agent.model,
		integrations,
		schedules,
		maxSteps: config.maxSteps ?? 20,
	}, null, 2));
	console.log('Note: this standalone fork validates the config locally. Wiring a');
	console.log('remote deploy target (daemon/registry) is a later Phase 2 step.');
}

async function cmdMcp(args: CliArgs): Promise<void> {
	const agentsDir = args.agentsDir ?? process.env.TASKLING_AGENTS_DIR ?? './agents';
	// Lazy import: keeps --help fast and avoids loading the MCP server for runs.
	const mcp = await import('../mcp/server.js');
	if (args.http) {
		if (!process.env.TASKLING_MCP_TOKEN) {
			console.error('taskling mcp --http requires TASKLING_MCP_TOKEN to be set (token-gated by design).');
			console.error('Set it in the environment (never as a CLI argument) and retry, or run stdio mode: taskling mcp');
			process.exit(1);
		}
		await mcp.startHttpServer({ agentsDir, host: args.host, port: args.port });
	} else {
		await mcp.startStdioServer(agentsDir);
	}
}

// ─── Schedule helpers ─────────────────────────────────────────────────────────

import type { ScheduleConfig } from '../types/index.js';

function parseSchedule(raw: Record<string, unknown>): ScheduleConfig {
	if (raw.type === 'interval') {
		return { type: 'interval', value: Number(raw.value) };
	}
	if (raw.type === 'daily') {
		const s: ScheduleConfig = {
			type: 'daily',
			hour: Number(raw.hour ?? 0),
			minute: Number(raw.minute ?? 0),
		};
		if (raw.dayOfWeek) (s as { dayOfWeek?: number[] }).dayOfWeek = raw.dayOfWeek as number[];
		if (raw.dayOfMonth) (s as { dayOfMonth?: number[] }).dayOfMonth = raw.dayOfMonth as number[];
		if (raw.timeZone) (s as { timeZone?: string }).timeZone = raw.timeZone as string;
		return s;
	}
	throw new Error(`Unknown schedule type: ${raw.type}`);
}

// ─── Run (legacy single-agent path) ───────────────────────────────────────────

async function cmdRun(args: CliArgs): Promise<void> {
	let configPath = args.configPath;
	if (!configPath) {
		if (existsSync(resolve('taskling.config.json'))) {
			configPath = 'taskling.config.json';
		} else {
			printHelp();
			process.exit(1);
		}
	}
	let config: AgentCliConfig;
	try {
		config = await loadConfig(configPath);
		validateAgentConfig(config, configPath);
	} catch (err) {
		console.error(`Error loading config: ${String(err)}`);
		process.exit(1);
	}

	if (args.verbose) config.verbose = true;

	if (args.dryRun) {
		console.log('Dry run – config parsed successfully:');
		console.log(JSON.stringify({ agent: config.agent.name, model: config.agent.model }, null, 2));
		process.exit(0);
	}

	// Lazy import Taskling (avoids loading all integrations on --help).
	const { OpenMolt } = await import('../OpenMolt.js');

	const om = new OpenMolt({
		llmProviders: config.llmProviders,
		integrations: config.integrations,
		maxSteps: config.maxSteps,
		verbose: config.verbose ?? args.verbose,
	});

	const agentCfg = config.agent;
	const agent = om.createAgent({
		name: agentCfg.name,
		model: agentCfg.model,
		instructions: agentCfg.instructions,
		instructionsPath: agentCfg.instructionsPath,
		modelConfig: agentCfg.modelConfig as Record<string, unknown>,
		integrations: agentCfg.integrations as never,
		memory: agentCfg.memory as never,
	});

	const scheduleIds: string[] = [];
	if (Array.isArray(agentCfg.schedules) && agentCfg.schedules.length > 0) {
		console.log(`Registering ${agentCfg.schedules.length} schedule(s)…`);
		for (const rawSched of agentCfg.schedules) {
			try {
				const sched = parseSchedule(rawSched as Record<string, unknown>);
				const id = agent.schedule(sched);
				scheduleIds.push(id);
				console.log(`  ✓ Schedule registered: ${id} (${JSON.stringify(sched)})`);
			} catch (err) {
				console.warn(`  ⚠ Invalid schedule: ${String(err)}`);
			}
		}
		if (scheduleIds.length > 0) {
			console.log('Taskling is running on schedule. Press Ctrl+C to stop.');
			process.on('SIGINT', () => {
				console.log('\nStopping scheduled Taskling…');
				process.exit(0);
			});
			await new Promise(() => {});
			return;
		}
	}

	const input = args.input ?? config.input ?? null;
	console.log(`Running Taskling "${agentCfg.name}" (${agentCfg.model})…`);

	agent.on('planUpdate', (e) => {
		const active = e.plan.find((s) => s.status === 'inProgress');
		if (active) console.log(`  ▶ ${active.name}`);
	});
	agent.on('tool:call', (e) => {
		console.log(`  🔧 ${e.tool.integration}.${e.tool.handle}`);
	});

	try {
		const result = await agent.run(input);
		console.log('\n✅ Taskling finished successfully.');
		console.log(JSON.stringify(result, null, 2));
		process.exit(0);
	} catch (err) {
		console.error('\n❌ Taskling failed:', String(err));
		process.exit(1);
	}
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const args = parseArgs(process.argv);
	if (args.help) {
		printHelp();
		process.exit(0);
	}
	if (args.command === 'init') return cmdInit(args);
	if (args.command === 'deploy') return cmdDeploy(args);
	if (args.command === 'mcp') return cmdMcp(args);
	return cmdRun(args);
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
