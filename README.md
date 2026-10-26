# Autocord v0.3 Alpha

Autocord is a private TypeScript/discord.js application. Agentcord Mini and Max use a configurable OpenAI-compatible external model to propose validated role-panel plans. The model has no Discord, database, shell, or arbitrary tool access. Application policy and the deterministic executor own every state change.

## Implemented Alpha Scope

- `/agent` creates a role-panel plan or edits a selected existing panel using Japanese natural-language instructions.
- Ambiguous edit requests show a guild-scoped panel selector. Preview includes the change summary, and approval is bound to the guild, job, expiry, and plan hash.
- Approval is claimed with one conditional PostgreSQL update. A PostgreSQL advisory lock serializes execution per guild across processes; panel revision compare-and-swap prevents stale edits.
- Autocord-created roles are recorded in `managed_roles`, always created with no permissions, and never adopted by matching names. Existing roles are eligible only when ownership is recorded, they are not managed/@everyone, they contain no restricted permissions, and both Bot/user hierarchy checks pass.
- Panel renderers support embeds, colors, buttons (up to five), select menus, single/multiple selection, and option emoji. Role interactions use stored guild-bound bindings and never invoke the LLM.
- Panel revisions store previous specs and bindings. `/autocord undo job_id:<id>` prepares an approval-gated compensating edit when a previous panel revision exists. It does not delete roles.
- `/autocord panels`, `/autocord usage`, and `/autocord history` provide guild-scoped views.
- `/giveaway create`, `/giveaway end`, and `/giveaway reroll` use persistent entries, unique `(giveaway_id,user_id)` keys, a restart-resilient due-time poller, cryptographic `randomInt` selection without replacement, and audit events.
- Guild/month/mode AI request limits default to Mini 30 and Max 5, one concurrent guild job by default, and a 10-second per-user cooldown. Usage rows store model, token counts, period, and configurable estimated rates.
- Startup and periodic lease recovery mark expired in-flight executions `RECOVERY_REQUIRED`; they are not replayed automatically because Discord API effects may already have occurred.
- `/health`, structured JSON operational logs, SIGINT/SIGTERM shutdown, Docker non-root/read-only runtime, and CI checks are included.

## Setup

Use Node.js 22. Copy `.env.example` to `.env` and configure Discord credentials, PostgreSQL, and the OpenAI-compatible endpoint/key. `DATABASE_URL` is for local Node.js; `DATABASE_URL_DOCKER` is for the Compose Bot container. Change the example database password before using a remotely reachable environment. Configure `AGENTCORD_MINI_MODEL`, `AGENTCORD_MAX_MODEL`, and optional `AI_FALLBACK_MODEL` for the models exposed by the selected provider.

Local development:

```sh
docker compose up -d postgres
npm ci
npm run db:migrate
npm run commands:deploy
npm run dev
```

The Bot needs `Guilds`, `Manage Roles`, `Manage Guild`, message send/history permissions. Guild-member privileged intent is not requested. Keep the Bot role above roles it creates. In Docker Compose, the Bot container applies the idempotent SQL migration before starting.

Full Compose runtime: `docker compose up --build -d`, then deploy commands with `docker compose run --rm bot node dist/deploy-commands.js`. Compose/Docker is not required for local development.

## Alpha Limits / Not Implemented

- Agentcord Max currently uses its independently configurable model, larger output budget, and longer timeout; multi-step skill decomposition and safe autonomous replanning are not implemented.
- Natural-language management is limited to role panels. Giveaway operations use `/giveaway`; AI-generated giveaway plans, pause/resume, and durable announcement outbox delivery are not implemented.
- Channel and general role management Skills, panel deletion, configurable guild settings UI, pages beyond the 25-item Discord select/list limits, and cross-server dashboard are not implemented.
- Job execution is serialized, claimed, and recoverable. A process crash after Discord effects but before DB commit is recorded for operator recovery; automatic external-state reconciliation is intentionally not guessed.
- New roles are compensated on failed publication where Discord permits deletion. If compensation fails, the job is persisted as `RECOVERY_REQUIRED`.
- The giveaway scheduler retries due `ACTIVE` rows after restart. A crash in the narrow window after marking a draw `DRAWING` or after saving winners but before posting the result may require manual recovery.
- Cost is an estimate. Set provider-specific input/output USD-per-million values to nonzero values; defaults are zero because provider rates are not assumed.
- No live Discord integration test has been run in this workspace.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_COMPATIBLE_BASE_URL` | `https://api.opencode.ai/v1` | OpenAI-compatible endpoint |
| `AGENTCORD_MINI_MODEL` | `deepseek-v4.1-flash-free` | Mini model ID |
| `AGENTCORD_MAX_MODEL` | `deepseek-v4.1-flash-free` | Max model ID |
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

`src/db/migrate.ts` is an idempotent additive migration suitable for upgrading the v0.1 schema without dropping existing rows. Existing panel specs are normalized and pending legacy approvals are expired. v0.1 reused same-named roles without recording ownership, so its existing `panel_options` are intentionally not imported into `managed_roles`; those old panels remain visible but self-service role assignment fails closed until recreated with this version. Back up production databases before deploying schema changes.
