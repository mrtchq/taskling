> **TASKLING — fork of OpenMolt, distributed from GitHub only.**
>
> **Do NOT `npm publish` this package.** The bare name `taskling` on npm
> is already taken by an unrelated package (`taskling@2.0.0`, maintainer
> elidoran, repo elidoran/node-taskling — "Small simple async function
> series"). By decision (2026-10-25), Taskling is GitHub-only for now:
> npm is skipped entirely. Install from the public repo:
>
> ```bash
> npm install github:mrtchq/taskling
> ```
>
> Public repo: <https://github.com/mrtchq/taskling> (fork of
> ybouane/openmolt.dev, MIT — see LICENSE, kept intact).
>
> Taskling is a fork of [OpenMolt](https://github.com/ybouane/openmolt.dev)
> (MIT, Copyright 2026 Yassine Bouanane — see LICENSE, kept intact).
> Brand: **Taskling** — "Spawn a Taskling", "Taskling Swarm" /
> "Active Tasklings", "Taskling Engine", states Idle / Dispatched / Sleeping.
> CLI: `taskling init`, `taskling deploy`, `taskling mcp`,
> `taskling taskling.config.json`.

# Taskling

**Programmatic AI Agent System for Node.js / TypeScript**

Taskling lets your code create autonomous AI agents that plan, reason, and act — calling real APIs, reading files, generating images, sending messages, and more. Agents run a self-directed reasoning loop (the *Maestro* loop) powered by any LLM until the task is complete.

```
npm install github:mrtchq/taskling
```

→ **[openmolt.dev](https://openmolt.dev/)** — upstream OpenMolt documentation (Taskling docs not yet published)

---

## Why Taskling?

| | |
|---|---|
| **Secure by design** | Agents access only the scopes you grant. The LLM sees tool names — never raw credentials |
| **Multi-provider** | OpenAI, Anthropic Claude, and Google Gemini with a unified `provider:model` string |
| **30+ built-in integrations** | Gmail, Slack, GitHub, Notion, Stripe, Discord, S3, and more — ready out of the box |
| **Declarative HTTP tools** | Define integrations as data (endpoint, auth, Liquid templates) — no boilerplate |
| **Typed output** | Pass a Zod schema; `agent.run()` returns a validated, typed object |
| **Scheduling** | Interval and cron-style daily schedules with timezone support |
| **Events** | Observable reasoning loop — hook into every tool call, plan update, and LLM output |
| **Memory** | Long-term and short-term memory stores with `onUpdate` persistence callbacks |
| **CLI** | `npx -p github:mrtchq/taskling taskling agent.json` to run agents from a config file |
---

## Secure by Design

Taskling was built with security as a first-class constraint, not an afterthought.

**Scope-gated tools.** Every integration is granted an explicit list of scopes when you attach it to an agent. If a tool requires the `write` scope and you only granted `read`, the agent cannot call it — regardless of what the LLM decides.

```typescript
integrations: [
  {
    integration: 'gmail',
    credential: { type: 'oauth2', config: { ... } },
    scopes: ['read'],   // agent can read emails, but cannot send or delete
  },
],
```

**Credentials never reach the LLM.** The model only sees tool names and their input/output schemas. Your API keys, tokens, and OAuth secrets are resolved server-side at execution time — the LLM prompt contains none of them.

**Directory-restricted filesystem.** The `FileSystem` integration is a factory that you instantiate with an explicit allowlist of directories. The agent cannot read or write outside those paths.

```typescript
om.registerIntegration('fileSystem', Taskling.FileSystemIntegration('./output'));
// agent cannot access /etc, ~/, or any path outside ./output
```

**No implicit network access.** Agents can only call APIs that are registered as integrations. There is no general-purpose outbound HTTP unless you explicitly add the `httpRequest` integration.

---

## Quick Start

```typescript
import Taskling from 'taskling';

const om = new Taskling({
  llmProviders: {
    openai: { apiKey: process.env.TASKLING_OPENAI_API_KEY },
  },
});

const agent = om.createAgent({
  name: 'Comedian',
  model: 'openai:gpt-4o-mini',
  instructions: 'You are a witty stand-up comedian.',
});

const result = await agent.run('Tell me a joke!');
console.log(result);
```

**Environment variables** (no config needed):

| Variable | Provider |
|---|---|
| `TASKLING_OPENAI_API_KEY` | OpenAI |
| `TASKLING_ANTHROPIC_API_KEY` | Anthropic |
| `TASKLING_GOOGLE_API_KEY` | Google Gemini |

---

## Model Strings

Choose any LLM with `provider:model-name`:

```typescript
model: 'openai:gpt-4o'
model: 'openai:o3-mini'
model: 'anthropic:claude-opus-4-6'
model: 'anthropic:claude-sonnet-4-6'
model: 'google:gemini-2.0-flash'
model: 'google:gemini-2.5-pro'
```

Optional per-model config:

```typescript
modelConfig: {
  thinking: true,      // Extended thinking (Anthropic / Gemini)
  search: true,        // Grounded web search (Gemini)
  temperature: 0.7,
}
```

---

## Examples

### Structured output with a Zod schema

```typescript
import { z } from 'zod';
import Taskling from 'taskling';

const om = new Taskling({ llmProviders: { openai: {} } });

const LogoSchema = z.object({
  logoUrl:    z.string().url(),
  altText:    z.string().optional(),
  confidence: z.enum(['high', 'medium', 'low']),
});

const agent = om.createAgent({
  name: 'LogoExtractor',
  model: 'openai:gpt-4o',
  instructions: 'Fetch the page with httpRequest and extract the logo URL.',
  integrations: [
    { integration: 'httpRequest', credential: { type: 'custom', config: {} }, scopes: 'all' },
  ],
  outputSchema: LogoSchema,
});

const result = await agent.run('https://example.com') as z.infer<typeof LogoSchema>;
console.log(result.logoUrl, result.confidence);
```

---

### Gmail draft generator that runs on a schedule

```typescript
import Taskling from 'taskling';

const om = new Taskling({ llmProviders: { openai: {} }, maxSteps: 30 });

const agent = om.createAgent({
  name: 'GmailDraftBot',
  model: 'openai:gpt-4o',
  instructions: `
    Fetch the 10 most recent unread emails.
    For each one, draft a professional reply using gmail → createDraft.
    Finish with a summary of how many drafts were created.
  `,
  integrations: [
    {
      integration: 'gmail',
      credential: {
        type: 'oauth2',
        config: {
          clientId:     process.env.GOOGLE_CLIENT_ID ?? '',
          clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
          refreshToken: process.env.GOOGLE_REFRESH_TOKEN ?? '',
        },
        onTokenRefresh: async (newConfig) => { /* persist tokens */ },
      },
      scopes: 'all',
    },
  ],
});

agent.on('tool:call', ({ tool }) =>
  console.log(`[tool] ${tool.integration}.${tool.handle}`)
);

// Run once now, then every 20 minutes
await agent.run('Process unread emails.');
const id = agent.schedule({ type: 'interval', value: 20 * 60 });

process.on('SIGINT', () => { agent.cancelSchedule(id); process.exit(0); });
```

---

### Blog post writer with AI-generated images

```typescript
import Taskling from 'taskling';

const om = new Taskling({ llmProviders: { openai: {} }, maxSteps: 40 });

// Restrict filesystem access to ./blog only
om.registerIntegration('fileSystem', Taskling.FileSystemIntegration('./blog'));

const agent = om.createAgent({
  name: 'BlogWriter',
  model: 'openai:gpt-4o',
  instructions: `
    1. Write a full Markdown blog post with front-matter.
    2. Generate 2-3 images with fal → generate (fal-ai/flux/schnell).
    3. Save the .md file to fileSystem with the fal CDN image URLs inline.
    4. Finish with the output path and image URLs.
  `,
  integrations: [
    { integration: 'fal',        credential: { type: 'bearer', config: { apiKey: process.env.FAL_API_KEY ?? '' } }, scopes: 'all' },
    { integration: 'fileSystem', credential: { type: 'custom', config: {} }, scopes: ['read', 'write'] },
  ],
});

const result = await agent.run('Write a blog post about the future of AI agents.');
console.log(result);
```

---

### Custom integration (declarative HTTP)

```typescript
import Taskling, { IntegrationDefinition } from 'taskling';
import { z } from 'zod';

const weatherDefinition: IntegrationDefinition = {
  name: 'Weather',
  apiSetup: {
    baseUrl: 'https://api.openweathermap.org/data/2.5',
    headers: { 'Content-Type': 'application/json' },
    responseFormat: 'json',
  },
  credentialSetup: [{ type: 'custom', queryParams: { appid: '{{ config.apiKey }}' } }],
  tools: [
    {
      handle: 'getCurrentWeather',
      description: 'Get current weather for a city.',
      method: 'GET',
      endpoint: '/weather',
      queryParams: { q: '{{ input.city }}', units: 'metric' },
      inputSchema:  z.object({ city: z.string() }),
      outputSchema: z.object({ temp: z.number(), description: z.string() }),
    },
  ],
};

const om = new Taskling({ llmProviders: { anthropic: {} } });
om.registerIntegration('weather', weatherDefinition);

const agent = om.createAgent({
  name: 'WeatherBot',
  model: 'anthropic:claude-sonnet-4-6',
  instructions: 'Answer questions about the current weather.',
  integrations: [
    { integration: 'weather', credential: { type: 'custom', config: { apiKey: process.env.WEATHER_API_KEY ?? '' } }, scopes: 'all' },
  ],
});

console.log(await agent.run('What is the weather in Tokyo?'));
```

---

### Daily scheduling with memory

```typescript
const agent = om.createAgent({
  name: 'ReportBot',
  model: 'google:gemini-2.0-flash',
  instructions: 'Pull metrics from Stripe and post a daily summary to Slack.',
  memory: {
    longTerm: {
      data: '',
      onUpdate: async (data) => await fs.writeFile('memory.txt', data),
    },
  },
  integrations: [
    { integration: 'stripe', credential: { type: 'bearer', config: { apiKey: process.env.STRIPE_SECRET_KEY ?? '' } }, scopes: 'all' },
    { integration: 'slack',  credential: { type: 'bearer', config: { apiKey: process.env.SLACK_BOT_TOKEN ?? '' } },  scopes: 'all' },
  ],
});

// Every weekday at 9 AM New York time
agent.schedule({
  type: 'daily',
  dayOfWeek: [1, 2, 3, 4, 5],
  hour: 9, minute: 0,
  timeZone: 'America/New_York',
});
```

---

## Built-in Integrations

| Category | Integrations |
|---|---|
| **Productivity** | Notion, Airtable, Google Calendar, Google Drive, Google Sheets, Microsoft Outlook |
| **Communication** | Gmail, Slack, Discord, Telegram, WhatsApp, Twilio |
| **Social / Content** | X (Twitter), Instagram, TikTok, YouTube |
| **AI / Media** | fal.ai, Google Imagen + Veo (Gemini Media Models), OpenAI Media Models (DALL-E / gpt-image-1) |
| **Commerce** | Stripe, Shopify, Etsy |
| **Dev & Cloud** | GitHub, AWS S3, Dropbox |
| **Ads** | Google Ads, Meta Ads |
| **Web** | browser-use.com (cloud browsing), Generic HTTP Request |
| **Local** | FileSystem (directory-restricted) |

---

## Events

Observe every step of the agent's reasoning:

```typescript
agent.on('llmOutput',      ({ output })         => console.log('LLM tokens used:', output.usage));
agent.on('commandsQueued', ({ commands })        => console.log('Next commands:', commands.length));
agent.on('tool:call',      ({ tool })            => console.log('Calling:', tool.integration, tool.handle));
agent.on('tool:response',  ({ tool, response })  => console.log('Response:', response));
agent.on('planUpdate',     ({ plan })            => console.log('Plan updated:', plan));
agent.on('finish',         ({ result })          => console.log('Done:', result));
```

---

## CLI

Run an agent from a JSON or JS config file:

```bash
npx -p github:mrtchq/taskling taskling agent.json
npx -p github:mrtchq/taskling taskling agent.json --input "Summarise this week's Stripe revenue" --verbose
npx -p github:mrtchq/taskling taskling agent.json --dry-run   # validate without running
```

**agent.json**

```json
{
  "llmProviders": { "openai": { "apiKey": "sk-..." } },
  "integrations": { "slack": { "apiKey": "xoxb-..." } },
  "agent": {
    "name": "SlackBot",
    "model": "openai:gpt-4o",
    "instructions": "Post a motivational message to #general every morning.",
    "integrations": [
      { "integration": "slack", "credential": { "type": "bearer", "config": {} }, "scopes": "all" }
    ],
    "schedules": [
      { "type": "daily", "hour": 8, "minute": 0, "timeZone": "UTC" }
    ]
  }
}
```

---

## Documentation

Full upstream docs, API reference, and more examples at **[openmolt.dev](https://openmolt.dev/)**. Taskling-specific docs: `docs/mcp.md` (MCP mode).

---

## License

MIT

---

## Taskling CLI

```bash
taskling init                    # scaffold taskling.config.json in .
taskling init ./my-agent --force # scaffold elsewhere / overwrite
taskling taskling.config.json --dry-run   # validate without running
taskling taskling.config.json             # run one agent
taskling deploy                  # validate taskling.config.json for deployment
taskling deploy my-config.json   # validate a named config
taskling mcp                     # MCP server over stdio (see docs/mcp.md)
taskling mcp --http --port 3000  # MCP over token-gated streamable HTTP
```

With no argument, `taskling` runs `./taskling.config.json` if it exists,
otherwise it prints help. `taskling deploy` is local validation only: this
standalone fork has no remote deploy target yet — wiring one is a later
Phase 2 step.

## Taskling MCP mode

`taskling mcp` serves exactly three tools over stdio (default) or
token-gated streamable HTTP (`--http`, requires `TASKLING_MCP_TOKEN`):

- `list_agents` — agents from `./agents/*.json` (or `TASKLING_AGENTS_DIR`).
- `run_agent` — start a run; waits with progress up to `waitMs`
  (default 120s, max 300s), then returns the `runId` if still running.
- `get_agent_run` — fetch a run by `runId` (status, progress, result, error).

Full details, including the HTTP auth contract and the in-memory-only run
store, are in [`docs/mcp.md`](docs/mcp.md). No per-agent tools are built
in this phase — that is a later option.

## Fork notes

- **Upstream:** ybouane/openmolt.dev, version 0.1.8 at fork time
  (commit ac6ca35, "Version bump 0.1.8"). The VPS's live control layer
  (`moltctl`, prod :7777) was NOT touched and is NOT repointed at this
  fork — this fork ships standalone first.
- **License:** MIT, Copyright 2026 Yassine Bouanane, kept intact in
  `LICENSE`. Do not remove it.
- **Code identifiers:** the library class and types keep their upstream
  names (`OpenMolt`, `OpenMoltConfig`) and are exported under the new
  brand as aliases (`Taskling`, `TasklingConfig` from `taskling`).
  Everything user-facing — package/bin name, CLI help, log prefix,
  env-var primary names (`TASKLING_*`, with `OPENMOLT_*` as fallback),
  README and docs — says Taskling.
- **Distribution (GitHub-only):** the public repo is
  <https://github.com/mrtchq/taskling> (fork of ybouane/openmolt.dev,
  fork linkage preserved). npm is skipped by decision (2026-10-25):
  the bare `taskling` name on npm is taken by an unrelated package
  (see banner at the top), so install from git only:
  `npm install github:mrtchq/taskling` (the `prepare` script builds
  `dist/` on install).
- **No tests upstream:** the upstream package has no `test` script, so
  verification for this fork is `npm run build` + `taskling --help` +
  the MCP stdio/HTTP checks described in `docs/mcp.md`.
