# Autocord v0.5 Alpha

Autocord is a private TypeScript/discord.js application. Agentcord Mini and Max use a configurable OpenAI-compatible external model to propose validated role-panel plans. The model has no Discord, database, shell, or arbitrary tool access. Application policy and the deterministic executor own every state change.

## Implemented Alpha Scope

- `/agent` uses Japanese instructions to create/edit role panels, create permissionless roles and text/category channels, or publish a reusable Interactive Workflow. Mini handles single-panel operations; select Max for multi-step panel/resource plans and Workflow composition. The preview shows all proposed effects and dependencies before approval.
- Ambiguous edit requests show a guild-scoped panel selector. Preview includes the change summary, and approval is bound to the guild, job, expiry, and plan hash.
- Approval is claimed with one conditional PostgreSQL update. A PostgreSQL advisory lock serializes execution per guild across processes; panel revision compare-and-swap prevents stale edits.
- Autocord-created roles are recorded in `managed_roles`, always created with no permissions, and never adopted by matching names. Existing roles are eligible only when ownership is recorded, they are not managed/@everyone, they contain no restricted permissions, and both Bot/user hierarchy checks pass.
- Interactive Workflows combine Components V2 UI, button/select/modal triggers, bounded declarative conditions, workflow/guild/member-scoped state, collections, unique entries, managed-role grants, notifications and panel refresh actions. Definitions, state, collections, entries and runs persist in PostgreSQL.
- Max role/channel creation plans are registry-backed Skills with per-step permission/risk metadata. Every operation is stored in `agent_job_steps`; created roles/channels are recorded in `managed_roles` / `managed_channels`. Channel permissions are not model-configurable and Discord defaults apply.
- Panel renderers support Discord Components V2 Container/Section/Text Display/Separator layouts with an accent color, as well as Classic Embeds. Both support buttons (up to five), select menus, single/multiple selection, and option emoji. New panels default to V2; upgraded v0.1 panels retain the Classic style. Discord makes the Components V2 message flag sticky, so a panel's rendering mode cannot be changed after publication; create a new panel to switch modes. Role interactions use stored guild-bound bindings and never invoke the LLM.
- Panel revisions store previous specs and bindings. `/autocord undo job_id:<id>` prepares an approval-gated compensating edit when a previous panel revision exists. It does not delete roles.
- `/autocord panels`, `/autocord usage`, and `/autocord history` provide guild-scoped views.
- `/autocord skills` lists registered Skills, including Workflow State/Math/Random/Collections, Discord operation/event Skills and workflow controls. Model-planned writes remain approval-gated; ordinary published Workflow execution does not call an LLM.
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

The Bot uses `Guilds`, `GuildVoiceStates`, `GuildMessages`, and `GuildMessageReactions`. `GuildMembers` and `MessageContent` are privileged and opt-in through `ENABLE_GUILD_MEMBERS_INTENT=true` / `ENABLE_MESSAGE_CONTENT_INTENT=true`; enable the corresponding intents in the Discord Developer Portal only when the Guild uses those triggers/features. Voice Workflow actions need `Manage Channels`, `Move Members`, `Connect`, and `View Channel` in the selected Lobby. Keep the Bot role above roles it creates. In Docker Compose, the Bot container applies the idempotent SQL migration before starting.

For the no-key OpenCode backend, run the Bot natively so it can reach the authenticated loopback OpenCode server. Full Compose Bot runtime defaults to the OpenAI-compatible backend (`AI_BACKEND_DOCKER=openai-compatible`) because a container's loopback cannot reach the host OpenCode service; provide that backend's endpoint/key or run only `docker compose up -d postgres` and start the Bot natively. Deploy commands with `npm run commands:deploy` from a shell with the Discord token in its environment.

## Alpha Limits / Not Implemented

- Agentcord Max has three disjoint planning targets: one-shot operations on a role panel, a role/channel resource batch, or an Interactive Workflow definition. Interactive Workflow actions are a typed allowlist; model output never becomes an arbitrary Discord/API call.
- Interactive Workflow creation is available as Max target `interactive`. `examples/workflows/valorant-recruitment.json` composes capped unique entries and count-refresh UI; `examples/workflows/onboarding-consent.json` composes member consent state and managed-role assignment; `examples/workflows/voice-session.json` composes VoiceState join/leave triggers, temporary VC creation/member moves and empty-channel deletion. All use the same schema and interpreter.
- The same trigger graph can compose permissionless Role creation, default-permission Category/Text Channel creation, and Giveaway create/join/leave/end/pause/resume/reroll actions. Resource and Giveaway management actions require an AND permission guard in the definition and recheck the triggering member at execution. Text Channels may depend on a Category step; Giveaway IDs can flow through state/result references. `examples/workflows/resources-and-giveaway.json` combines these operations in one definition.
- `voice-session.json` contains a nonfunctional placeholder Lobby ID. Max uses the guild's existing Voice Channel list, asks which Lobby when ambiguous, validates the selected ID/type/permissions, and only manages temporary VCs it created for that Workflow.
- Component, Modal, interval, deadline, weekly calendar/timezone, VoiceState, member, message and reaction triggers are implemented. Nested AND/OR/NOT conditions are bounded to depth 8 and 64 nodes. Automatic Workflow discovery without choosing a workflow_id and arbitrary cross-workflow calls are not implemented.
- Natural language can create/edit panels and can create/edit a selected Interactive Workflow using the `workflow_id` autocomplete option. Generic role/channel creation and Giveaway behavior can be composed into Interactive Workflows. `/giveaway` remains for direct administration.
- Workflow-owned Channel/Role rename and Channel delete are supported; unowned resource edits/deletes, Role deletion, arbitrary permission overwrites, role-panel deletion/edit actions inside Interactive Workflow, configurable guild settings UI, pages beyond the 25-item Discord select/list limits and cross-server dashboard are not implemented.
- Read-only utility Skills (`role.list`, `channel.list`, `usage.read`, `audit.list`, `job.status`) and the legacy role-panel `undo`/option-edit operations remain on their current slash/Max-plan paths rather than becoming event-triggered Workflow steps.
- Job execution is serialized, claimed, and recoverable. A process crash after Discord effects but before DB commit is recorded for operator recovery; automatic external-state reconciliation is intentionally not guessed.
- Panel publication attempts to compensate newly created roles if the message/DB update fails. Resource workflows preserve already-created resources on partial failure and enter `RECOVERY_REQUIRED` for operator reconciliation.
- The giveaway scheduler recovers interrupted `DRAWING` rows and retries notification outbox rows with exponential backoff. Delivery is at-least-once: a crash after Discord accepts a message but before the outbox is marked sent can cause a duplicate announcement.
- Cost is an estimate. Set provider-specific input/output USD-per-million values to nonzero values; defaults are zero because provider rates are not assumed.
- Gateway handlers are covered by schemas and mocks where available, but no live test-guild end-to-end publish, message/reaction, member-intent, VoiceState or schedule.at operation has been performed for this expansion.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_BACKEND` | `opencode-server` | `opencode-server` (keyless local auth) or `openai-compatible` |
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:4197` | Authenticated local OpenCode HTTP API |
| `AGENTCORD_MINI_MODEL` | `river/deepseek-v4.1-flash` | Mini provider/model ID |
| `AGENTCORD_MAX_MODEL` | `river/deepseek-v4.1-flash` | Max provider/model ID |
| `AGENTCORD_REASONER_MODE` | `off` | ARE feature flag: `off` (legacy), `shadow` (run both, return legacy), `on` (ARE result) |
| `AGENTCORD_REASONING_MODE` | `auto` | ARE effort: `auto`, `fast`, `deep`, or `research` |
| `AGENTCORD_REASONER_MAX_CALLS` | `8` | ARE total model-call limit, including fallback attempts (clamped 2..12) |
| `AGENTCORD_REASONER_MAX_CANDIDATES` | `3` | Bounded distinct candidate limit (clamped 1..3) |
| `AGENTCORD_REASONER_MAX_REPAIRS` | `2` | Counterexample-guided repair limit per run (clamped 0..4) |
| `AGENTCORD_REASONER_INPUT_TOKENS` | `120000` | ARE estimated/observed aggregate input token budget (clamped 10,000..120,000) |
| `AGENTCORD_REASONER_OUTPUT_TOKENS` | `16000` | ARE output token budget (clamped 2,000..32,000) |
| `AGENTCORD_REASONER_TIMEOUT_MS` | `90000` | ARE wall-clock budget (clamped 10,000..180,000 ms) |
| `AGENTCORD_REASONER_CALL_TIMEOUT_MS` | `30000` | Per model-call wall-clock cap within the ARE total budget (clamped 5,000..60,000 ms) |
| `OPENAI_COMPATIBLE_BASE_URL` | `https://api.opencode.ai/v1` | OpenAI-compatible endpoint when selected |
| `AI_FALLBACK_MODEL` | empty | One fallback model after a primary failure |
| `MINI_MONTHLY_LIMIT` / `MAX_MONTHLY_LIMIT` | `0` / `0` | Per-guild monthly limits; `0` means unlimited |
| `MAX_CONCURRENT_JOBS_PER_GUILD` | `1` | Guild-local pending/executing job cap |
| `MAX_CONCURRENT_AI_JOBS` | `5` | Global pending/executing AI job cap |
| `MAX_CONCURRENT_WORKFLOW_RUNS` | `20` | Global Interactive Workflow run cap (clamped 1..100) |
| `MAX_WORKFLOW_RUN_MS` | `30000` | Workflow run budget checked between steps (clamped 1,000..120,000 ms) |
| `WORKFLOW_TRIGGER_COOLDOWN_MS` | `1000` | Per-member, per-Workflow trigger cooldown |
| `MAX_ACTIVE_WORKFLOWS_PER_GUILD` | `50` | Guild-local active definition storage cap (clamped 1..500) |
| `MAX_VOICE_MOVE_MEMBERS_PER_TRIGGER` | `20` | Maximum humans moved from a Voice Lobby by one temporary-channel trigger (clamped 1..50) |
| `MAX_RESOURCES_PER_WORKFLOW` | `10` | Maximum non-ticket Workflow-owned Roles/Channels (clamped 1..50) |
| `MAX_TICKETS_PER_WORKFLOW` | `100` | Maximum private ticket channels per Workflow (clamped 1..1,000) |
| `MAX_ITEMS_PER_WORKFLOW_COLLECTION` | `1000` | Default Workflow Collection capacity (clamped 1..10,000) |
| `ENABLE_GUILD_MEMBERS_INTENT` | `false` | Opt in to member join/leave/role events and accurate Role member counts |
| `ENABLE_MESSAGE_CONTENT_INTENT` | `false` | Opt in to message content templates on message/reaction triggers |
| `APPROVAL_TTL_MINUTES` | `10` | Preview expiry |
| `AI_INPUT_USD_PER_MILLION` / `AI_OUTPUT_USD_PER_MILLION` | `0` | Cost estimate rates |

## Verification

ARE 1.0 is opt-in. Start with `AGENTCORD_REASONER_MODE=shadow`: legacy results remain authoritative while ARE diagnostics/cost are recorded with the plan; use `on` only after evaluating. The 100-case ARE set keeps a 20% holdout per category. Run a small paired tuning sample with `npm run eval:are -- reports/are-dev.jsonl 0 10 tuning both`; the last arguments select split (`all`, `tuning`, `holdout`) and method (`legacy`, `reasoner`, `both`). Semantic correctness is left unscored for blind review rather than inferred from Action-name presence. Do not tune against the `holdout` split.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm audit
```

`src/db/migrate.ts` is an idempotent additive migration suitable for upgrading the v0.1 schema without dropping existing rows. Existing panel specs are normalized; legacy executions without leases become `RECOVERY_REQUIRED`, and approvals with the previous hash format expire and require a new preview. v0.1 reused same-named roles without recording ownership, so its existing `panel_options` are intentionally not imported into `managed_roles`; those old panels remain visible but self-service role assignment fails closed until recreated with this version. Back up production databases before deploying schema changes.

## Workflow Engine

Agentcord Max can propose an `interactive` target that defines a Components V2 panel, button/select/modal triggers, bounded AND/OR conditions, and ordered actions. The same interpreter handles entry caps, user/workflow state, managed-role assignment, notifications, and panel refresh. `examples/workflows/valorant-recruitment.json` and `examples/workflows/onboarding-consent.json` demonstrate composition without feature-specific runtime branches.

Published definitions and interaction runs are guild-scoped and versioned; interval/deadline triggers use a persistent lease-backed schedule table, interaction IDs deduplicate runs and entry rows use a database unique key. Max can create and version-edit an Interactive Workflow by selecting its guild-scoped `workflow_id` and describing the change in Japanese. This build has unit/schema and PostgreSQL integration coverage but has not been exercised against a live Discord test guild for the Workflow interaction paths.

Max request validation checks inquiry forms, capped recruitment, Voice lifecycle, points, private tickets and reaction votes against the generated target/action graph before approval. Requests are checked against both an LLM-emitted structured requirement contract and deterministic application validators. Unsupported requirements are reported before generating a substitute feature. Clarification questions open an answer Modal and replan. Mini directs multi-trigger requests to Max instead of converting them into role panels.

## v0.5 Workflow Expansion

State actions include `set/get/increment/decrement/multiply/debit/delete/reset/append/remove`. Numeric mutations and thresholded `state.debit` use a PostgreSQL transaction-scoped advisory lock keyed by workflow/scope/scope-id/key, preventing lost updates and negative-balance redemption races. State list append/remove is serialized and capped at 1,000 items. Workflow, guild and member scopes are supported; member-scoped access is rejected on scheduled triggers.

Math actions include `add/subtract/multiply/divide/min/max/clamp`; Random uses cryptographic `random.integer/choice/weighted_choice`. Persistent Collections support `add/remove/count/contains/list/rank/clear`, scalar JSON items and member/guild/workflow scopes. Rank requires numeric values. Defaults/hard caps limit each Collection to 1,000/10,000 items, each Workflow to 20,000 rows and approximately 10 MiB of payload. Collections have unique scoped item keys and indexed PostgreSQL storage. `partitionByMessage` allows unique per-message reaction-vote collections.

Conditions include numeric comparisons, string equals/contains/starts_with, State/Collection membership, member role/permission, time, random chance and prior result checks. Declarative `and/or/not` trees are limited to depth 8 and 64 nodes; arbitrary JavaScript is not in the DSL. Typed State/result templates are supported. Conditional branching is built by applying `when` to dependent steps. No loop/recursion action is available.

Discord operations now include Workflow-owned message send/edit/reply/DM/delete/pin/unpin, Channel text/voice creation, rename/delete, two safe ticket permission presets, Voice member movement/listing, and Workflow-owned Role rename/count/grant/revoke. Message edit/delete/pin/unpin targets are resolved through the Workflow message ledger. Channels and Roles may only be renamed/deleted when ownership is recorded; ticket close authorization is checked against the creator or its configured staff Role. Permission presets set only View/Send/ReadHistory. Per-run outbound messages are capped at five.

Triggers include button/select/modal, interval/deadline, weekly calendar `schedule.at` with IANA timezone, VoiceState, member join/leave/role changes, message create/delete and reaction add/remove. GuildMembers and MessageContent privileged intents default off. Bot-authored messages/reactions are ignored and Bot-driven role changes are suppressed from looping back into role triggers.

`workflow.wait` stores a bounded checkpoint and due time in PostgreSQL; a lease-backed worker resumes after restart. Definitions can be paused/resumed/disabled/deleted with `/autocord workflow-pause`, `workflow-resume`, `workflow-disable`, and `workflow-delete`. Editing preserves unchanged schedule rows and waiting runs retain their versioned trigger snapshot. Retries are limited to known idempotent steps before any external side effect; ambiguous runs become `RECOVERY_REQUIRED`. Deleting a Workflow removes its UI and cancels timers/waits but deliberately leaves its tracked Discord Role/Channel resources in place for explicit cleanup.

Scenarios A (unique join award and atomic threshold debit), C (Modal to staff-only ticket, creator/staff close), D (Voice Lobby threshold lifecycle, not button-signup-to-voice), and E (unique per-message reaction votes with threshold notification) have deterministic plan validators and schema/unit cases. Scenario B's full combat/shop loop is not implemented. Scenario F needs local clock time, IANA timezone, and event duration/end time before it can reset a leaderboard after the event; `schedule.at` and persistent `workflow.wait` cover those timing primitives once specified. No 1,000-10,000 Guild performance guarantee is made without a representative load test.

Remaining: `state.changed`, safe repeated loop/iteration construct, a user-facing cancellation token for in-flight operations, complete resource cleanup of Roles (deletion is intentionally not automatic), audit/log retention cleanup policy, and representative load testing. PostgreSQL integration/restart/concurrency tests require `TEST_DATABASE_URL`; live Discord test-guild operations were not performed in this environment.
