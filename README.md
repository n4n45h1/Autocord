# Autocord v0.4 Alpha

Autocord is a private TypeScript/discord.js application. Agentcord Mini and Max use a configurable OpenAI-compatible external model to propose validated role-panel plans. The model has no Discord, database, shell, or arbitrary tool access. Application policy and the deterministic executor own every state change.

## Implemented Alpha Scope

- `/agent` uses Japanese instructions to create/edit role panels, create permissionless roles and text/category channels, or publish a reusable Interactive Workflow. Mini handles single-panel operations; select Max for multi-step panel/resource plans and Workflow composition. The preview shows all proposed effects and dependencies before approval.
- Ambiguous edit requests show a guild-scoped panel selector. Preview includes the change summary, and approval is bound to the guild, job, expiry, and plan hash.
- Approval is claimed with one conditional PostgreSQL update. A PostgreSQL advisory lock serializes execution per guild across processes; panel revision compare-and-swap prevents stale edits.
- Autocord-created roles are recorded in `managed_roles`, always created with no permissions, and never adopted by matching names. Existing roles are eligible only when ownership is recorded, they are not managed/@everyone, they contain no restricted permissions, and both Bot/user hierarchy checks pass.
- Interactive Workflows combine Components V2 UI, button/select/modal triggers, bounded conditions, scoped state, unique entries, managed-role grants, notifications and panel refresh actions. Definitions, state, entries and runs persist in PostgreSQL.
- Max role/channel creation plans are registry-backed Skills with per-step permission/risk metadata. Every operation is stored in `agent_job_steps`; created roles/channels are recorded in `managed_roles` / `managed_channels`. Channel permissions are not model-configurable and Discord defaults apply.
- Panel renderers support Discord Components V2 Container/Section/Text Display/Separator layouts with an accent color, as well as Classic Embeds. Both support buttons (up to five), select menus, single/multiple selection, and option emoji. New panels default to V2; upgraded v0.1 panels retain the Classic style. Discord makes the Components V2 message flag sticky, so a panel's rendering mode cannot be changed after publication; create a new panel to switch modes. Role interactions use stored guild-bound bindings and never invoke the LLM.
- Panel revisions store previous specs and bindings. `/autocord undo job_id:<id>` prepares an approval-gated compensating edit when a previous panel revision exists. It does not delete roles.
- `/autocord panels`, `/autocord usage`, and `/autocord history` provide guild-scoped views.
- `/autocord skills` lists the registered Skill catalog; current entries cover panel create/edit/workflow/list/undo, role create/list/self-assign/self-revoke, category/text-channel create/list, Giveaway create/end/reroll/pause/resume/join/leave, usage/settings/audit views and job status. Model-planned writes remain limited to approval-gated panel and resource workflows; slash/component Skills execute their own scoped schemas and permission checks.
- `/giveaway create`, `/giveaway end`, `/giveaway pause`, `/giveaway resume`, and `/giveaway reroll` use persistent entries, unique `(giveaway_id,user_id)` keys, a restart-resilient due-time poller, cryptographic `randomInt` selection without replacement, audit events, and a transactional notification outbox with retry/backoff.
- The Skills catalog also includes Max-authored Interactive Workflow publish/actions; Max writes are approval-gated, and published component runs are restricted to their schema-validated action graph.
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

The Bot needs `Guilds`, `Manage Roles`, `Manage Guild`, message send/history permissions. Voice Workflow actions additionally need the `GuildVoiceStates` intent and `Manage Channels`, `Move Members`, `Connect`, and `View Channel` permissions in the selected Lobby. Guild-member privileged intent is not requested. Keep the Bot role above roles it creates. In Docker Compose, the Bot container applies the idempotent SQL migration before starting.

For the no-key OpenCode backend, run the Bot natively so it can reach the authenticated loopback OpenCode server. Full Compose Bot runtime defaults to the OpenAI-compatible backend (`AI_BACKEND_DOCKER=openai-compatible`) because a container's loopback cannot reach the host OpenCode service; provide that backend's endpoint/key or run only `docker compose up -d postgres` and start the Bot natively. Deploy commands with `npm run commands:deploy` from a shell with the Discord token in its environment.

## Alpha Limits / Not Implemented

- Agentcord Max has three disjoint planning targets: one-shot operations on a role panel, a role/channel resource batch, or an Interactive Workflow definition. The published Interactive Workflow engine can then compose typed resource-create and Giveaway actions with UI, state and triggers; it does not execute arbitrary model-provided API calls.
- Interactive Workflow creation is available as Max target `interactive`. `examples/workflows/valorant-recruitment.json` composes capped unique entries and count-refresh UI; `examples/workflows/onboarding-consent.json` composes member consent state and managed-role assignment; `examples/workflows/voice-session.json` composes VoiceState join/leave triggers, temporary VC creation/member moves and empty-channel deletion. All use the same schema and interpreter.
- The same trigger graph can compose permissionless Role creation, default-permission Category/Text Channel creation, and Giveaway create/join/leave/end/pause/resume/reroll actions. Resource and Giveaway management actions require an AND permission guard in the definition and recheck the triggering member at execution. Text Channels may depend on a Category step; Giveaway IDs can flow through state/result references. `examples/workflows/resources-and-giveaway.json` combines these operations in one definition.
- `voice-session.json` contains a nonfunctional placeholder Lobby ID. Max uses the guild's existing Voice Channel list, asks which Lobby when ambiguous, validates the selected ID/type/permissions, and only manages temporary VCs it created for that Workflow.
- Component, Modal, recurring interval and deadline triggers are implemented. Nested condition trees, automatic Workflow discovery without choosing a workflow_id, and arbitrary cross-workflow calls are not implemented.
- Natural language can create/edit panels and can create/edit a selected Interactive Workflow using the `workflow_id` autocomplete option. Role/Channel creation and Giveaway behavior can be composed into Interactive Workflows. `/giveaway` remains for existing direct administration; autonomous Giveaway plans outside a typed Workflow are not implemented.
- Role/channel editing or deletion, permission-overwrite design, role-panel deletion/edit actions inside Interactive Workflow, configurable guild settings UI, pages beyond the 25-item Discord select/list limits, and cross-server dashboard are not implemented.
- Read-only utility Skills (`role.list`, `channel.list`, `usage.read`, `audit.list`, `job.status`) and the legacy role-panel `undo`/option-edit operations remain on their current slash/Max-plan paths rather than becoming event-triggered Workflow steps.
- Job execution is serialized, claimed, and recoverable. A process crash after Discord effects but before DB commit is recorded for operator recovery; automatic external-state reconciliation is intentionally not guessed.
- Panel publication attempts to compensate newly created roles if the message/DB update fails. Resource workflows preserve already-created resources on partial failure and enter `RECOVERY_REQUIRED` for operator reconciliation.
- The giveaway scheduler recovers interrupted `DRAWING` rows and retries notification outbox rows with exponential backoff. Delivery is at-least-once: a crash after Discord accepts a message but before the outbox is marked sent can cause a duplicate announcement.
- Cost is an estimate. Set provider-specific input/output USD-per-million values to nonzero values; defaults are zero because provider rates are not assumed.
- The Bot Gateway/health and River Max planning were exercised; no test-guild end-to-end Interactive Workflow publish, component/Modal interaction, VoiceState event, or scheduled execution has been performed.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_BACKEND` | `opencode-server` | `opencode-server` (keyless local auth) or `openai-compatible` |
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:4197` | Authenticated local OpenCode HTTP API |
| `AGENTCORD_MINI_MODEL` | `river/deepseek-v4.1-flash` | Mini provider/model ID |
| `AGENTCORD_MAX_MODEL` | `river/deepseek-v4.1-flash` | Max provider/model ID |
| `OPENAI_COMPATIBLE_BASE_URL` | `https://api.opencode.ai/v1` | OpenAI-compatible endpoint when selected |
| `AI_FALLBACK_MODEL` | empty | One fallback model after a primary failure |
| `MINI_MONTHLY_LIMIT` / `MAX_MONTHLY_LIMIT` | `0` / `0` | Per-guild monthly limits; `0` means unlimited |
| `MAX_CONCURRENT_JOBS_PER_GUILD` | `1` | Guild-local pending/executing job cap |
| `MAX_CONCURRENT_AI_JOBS` | `5` | Global pending/executing AI job cap |
| `MAX_CONCURRENT_WORKFLOW_RUNS` | `20` | Global Interactive Workflow run cap (clamped 1..100) |
| `WORKFLOW_TRIGGER_COOLDOWN_MS` | `1000` | Per-member, per-Workflow trigger cooldown |
| `MAX_ACTIVE_WORKFLOWS_PER_GUILD` | `50` | Guild-local active definition storage cap (clamped 1..500) |
| `MAX_VOICE_MOVE_MEMBERS_PER_TRIGGER` | `20` | Maximum humans moved from a Voice Lobby by one temporary-channel trigger (clamped 1..50) |
| `MAX_RESOURCES_PER_WORKFLOW` | `10` | Maximum Workflow-owned Roles/Channels created by runtime actions (clamped 1..50) |
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

## v0.4 Workflow Engine

Agentcord Max can propose an `interactive` target that defines a Components V2 panel, button/select/modal triggers, bounded AND/OR conditions, and ordered actions. The same interpreter handles entry caps, user/workflow state, managed-role assignment, notifications, and panel refresh. `examples/workflows/valorant-recruitment.json` and `examples/workflows/onboarding-consent.json` demonstrate composition without feature-specific runtime branches.

Published definitions and interaction runs are guild-scoped and versioned; interval/deadline triggers use a persistent lease-backed schedule table, interaction IDs deduplicate runs and entry rows use a database unique key. Max can create and version-edit an Interactive Workflow by selecting its guild-scoped `workflow_id` and describing the change in Japanese. This build has unit/schema and PostgreSQL integration coverage but has not been exercised against a live Discord test guild for the Workflow interaction paths.

Max request analysis/validation now checks inquiry forms, capped recruitment and voice-channel lifecycle requirements against the generated target and actions before approval. Inquiry forms require a Modal, member-scoped field persistence and owner-DM delivery; submitted fields are rejected from public panel/channel messages. Voice-channel creation/member lifecycle/deletion is not implemented, so those requests report the missing Skills and do not publish a recruitment-only substitute. Clarification requests with missing Skills have no approval path; supported clarification questions open an answer Modal and then replan. Mini directs multi-trigger requests to Max instead of converting them into role panels.
