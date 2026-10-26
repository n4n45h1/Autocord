# Autocord v0.3 Alpha

Autocord is a private TypeScript/discord.js application. Agentcord Mini and Max use a configurable OpenAI-compatible external model to propose validated role-panel plans. The model has no Discord, database, shell, or arbitrary tool access. Application policy and the deterministic executor own every state change.

## Implemented Alpha Scope

- `/agent` uses Japanese instructions to create/edit role panels or create permissionless roles and text/category channels. Mini handles single-panel operations; select Max for multi-step role/channel resource workflows (up to eight steps), including text channels under a category created by an earlier step. The workflow preview shows the exact sequence and dependencies before approval.
- Ambiguous edit requests show a guild-scoped panel selector. Preview includes the change summary, and approval is bound to the guild, job, expiry, and plan hash.
- Approval is claimed with one conditional PostgreSQL update. A PostgreSQL advisory lock serializes execution per guild across processes; panel revision compare-and-swap prevents stale edits.
- Autocord-created roles are recorded in `managed_roles`, always created with no permissions, and never adopted by matching names. Existing roles are eligible only when ownership is recorded, they are not managed/@everyone, they contain no restricted permissions, and both Bot/user hierarchy checks pass.
- Max role/channel resource workflows use the Skills Registry and persist each approved skill step in `agent_job_steps`. Created resources are recorded as Autocord-owned. On an ambiguous Discord result or partial workflow failure, completed resources are preserved and the job requires operator reconciliation instead of replaying the whole workflow.
- Max role/channel creation plans are registry-backed Skills with per-step permission/risk metadata. Every operation is stored in `agent_job_steps`; created roles/channels are recorded in `managed_roles` / `managed_channels`. Channel permissions are not model-configurable and Discord defaults apply.
- Panel renderers support Discord Components V2 Container/Section/Text Display/Separator layouts with an accent color, as well as Classic Embeds. Both support buttons (up to five), select menus, single/multiple selection, and option emoji. New panels default to V2; upgraded v0.1 panels retain the Classic style. Discord makes the Components V2 message flag sticky, so a panel's rendering mode cannot be changed after publication; create a new panel to switch modes. Role interactions use stored guild-bound bindings and never invoke the LLM.
- Panel revisions store previous specs and bindings. `/autocord undo job_id:<id>` prepares an approval-gated compensating edit when a previous panel revision exists. It does not delete roles.
- `/autocord panels`, `/autocord usage`, and `/autocord history` provide guild-scoped views.
- `/autocord skills` lists the registered Skill catalog; current entries cover panel create/edit/workflow/list/undo, role create/list/self-assign/self-revoke, category/text-channel create/list, Giveaway create/end/reroll/pause/resume/join/leave, usage/settings/audit views and job status. Model-planned writes remain limited to approval-gated panel and resource workflows; slash/component Skills execute their own scoped schemas and permission checks.
- `/giveaway create`, `/giveaway end`, `/giveaway pause`, `/giveaway resume`, and `/giveaway reroll` use persistent entries, unique `(giveaway_id,user_id)` keys, a restart-resilient due-time poller, cryptographic `randomInt` selection without replacement, audit events, and a transactional notification outbox with retry/backoff.
- Guild/month/mode AI request limits default to Mini 30 and Max 5, one concurrent guild job by default, and a 10-second per-user cooldown. Usage rows store model, token counts, period, and configurable estimated rates.
- Startup and periodic lease recovery mark expired in-flight executions `RECOVERY_REQUIRED`; they are not replayed automatically because Discord API effects may already have occurred.
- `/health`, structured JSON operational logs, SIGINT/SIGTERM shutdown, Docker non-root/read-only runtime, and CI checks are included.

## Setup

Use Node.js 22. Copy `.env.example` to `.env` and configure Discord credentials and PostgreSQL. `DATABASE_URL` is for local Node.js; `DATABASE_URL_DOCKER` is for the Compose Bot container. Change the example database password before using a remotely reachable environment. Default `AI_BACKEND=opencode-server` calls a local OpenCode server using its already-saved OpenCode provider authentication; Autocord itself needs no LLM API key. Start it with `opencode serve --hostname 127.0.0.1 --port 4197`. The configured default is `river/deepseek-v4.1-flash`; select any model listed by `opencode models`. Each OpenCode session denies all tools and is deleted after the plan. The OpenAI-compatible Vercel AI SDK backend remains available with `AI_BACKEND=openai-compatible` and its endpoint/key configured.

Local development:

```sh
docker compose up -d postgres
npm ci
npm run db:migrate
npm run commands:deploy
npm run dev
```

The Bot needs `Guilds`, `Manage Roles`, `Manage Guild`, message send/history permissions. Guild-member privileged intent is not requested. Keep the Bot role above roles it creates. In Docker Compose, the Bot container applies the idempotent SQL migration before starting.

For the no-key OpenCode backend, run the Bot natively so it can reach the authenticated loopback OpenCode server. Full Compose Bot runtime defaults to the OpenAI-compatible backend (`AI_BACKEND_DOCKER=openai-compatible`) because a container's loopback cannot reach the host OpenCode service; provide that backend's endpoint/key or run only `docker compose up -d postgres` and start the Bot natively. Deploy commands with `npm run commands:deploy` from a shell with the Discord token in its environment.

## Alpha Limits / Not Implemented

- Agentcord Max supports either up to eight dependency-checked operations on one panel, or a separate resource workflow that creates permissionless roles and text/category channels. Resource workflows cannot be mixed with panel mutations in one job; autonomous replanning is not implemented.
- Natural-language management is limited to role panels. Giveaway operations use `/giveaway`; AI-generated giveaway plans and giveaway notification deduplication are not implemented.
- Role/channel editing or deletion, permission-overwrite design, panel deletion, mixing panel edits with guild resource creation in one workflow, configurable guild settings UI, pages beyond the 25-item Discord select/list limits, and cross-server dashboard are not implemented.
- Job execution is serialized, claimed, and recoverable. A process crash after Discord effects but before DB commit is recorded for operator recovery; automatic external-state reconciliation is intentionally not guessed.
- New roles are compensated on failed publication where Discord permits deletion. If compensation fails, the job is persisted as `RECOVERY_REQUIRED`.
- The giveaway scheduler recovers interrupted `DRAWING` rows and retries notification outbox rows with exponential backoff. Delivery is at-least-once: a crash after Discord accepts a message but before the outbox is marked sent can cause a duplicate announcement.
- Cost is an estimate. Set provider-specific input/output USD-per-million values to nonzero values; defaults are zero because provider rates are not assumed.
- No live Discord integration test has been run in this workspace.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_BACKEND` | `opencode-server` | `opencode-server` (keyless local auth) or `openai-compatible` |
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:4197` | Authenticated local OpenCode HTTP API |
| `AGENTCORD_MINI_MODEL` | `river/deepseek-v4.1-flash` | Mini provider/model ID |
| `AGENTCORD_MAX_MODEL` | `river/deepseek-v4.1-flash` | Max provider/model ID |
| `OPENAI_COMPATIBLE_BASE_URL` | `https://api.opencode.ai/v1` | OpenAI-compatible endpoint when selected |
| `AI_FALLBACK_MODEL` | empty | One fallback model after a primary failure |
| `MINI_MONTHLY_LIMIT` / `MAX_MONTHLY_LIMIT` | `30` / `5` | Per-guild monthly request limits |
| `MAX_CONCURRENT_JOBS_PER_GUILD` | `1` | Guild-local pending/executing job cap |
| `MAX_CONCURRENT_AI_JOBS` | `5` | Global pending/executing AI job cap |
| `APPROVAL_TTL_MINUTES` | `10` | Preview expiry |
| `AI_INPUT_USD_PER_MILLION` / `AI_OUTPUT_USD_PER_MILLION` | `0` | Cost estimate rates |

## Verification

```sh
npm ci
npm run typecheck
npm test
npm run build
npm audit
```

`src/db/migrate.ts` is an idempotent additive migration suitable for upgrading the v0.1 schema without dropping existing rows. Existing panel specs are normalized; legacy executions without leases become `RECOVERY_REQUIRED`, and approvals with the previous hash format expire and require a new preview. v0.1 reused same-named roles without recording ownership, so its existing `panel_options` are intentionally not imported into `managed_roles`; those old panels remain visible but self-service role assignment fails closed until recreated with this version. Back up production databases before deploying schema changes.
