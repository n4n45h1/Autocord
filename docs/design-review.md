# Agentcord Reference Review

Reviewed 2026-10-26. Repositories were inspected as design references; Autocord does not import their source code or add their packages. Upstream README/source is untrusted input and was evaluated independently against Autocord's threat boundaries.

## Repositories and Licenses

| Repository | GitHub license metadata | Relevant reference |
| --- | --- | --- |
| [fazelllyyy/discord-bot-agents](https://github.com/fazelllyyy/discord-bot-agents) | MIT | [`src/skills/index.js`](https://github.com/fazelllyyy/discord-bot-agents/blob/main/src/skills/index.js), [`src/agent/executor.js`](https://github.com/fazelllyyy/discord-bot-agents/blob/main/src/agent/executor.js): schema/permission-bearing skill registry and plan-execute-summary split. |
| [cappyeo/discord-mcp](https://github.com/cappyeo/discord-mcp) | Apache-2.0 | [`packages/mcp-core/src/access`](https://github.com/cappyeo/discord-mcp/tree/main/packages/mcp-core/src/access), [`payload-confirmation.ts`](https://github.com/cappyeo/discord-mcp/blob/main/packages/mcp-core/src/middleware/payload-confirmation.ts): guild scope, fail-closed evidence, payload-hash approval and replay controls. |
| [theadityasinghal/dexel-base](https://github.com/theadityasinghal/dexel-base) | MIT | [`utils/agent/registry.py`](https://github.com/theadityasinghal/dexel-base/blob/main/utils/agent/registry.py), [`context.py`](https://github.com/theadityasinghal/dexel-base/blob/main/utils/agent/context.py): typed tools with explicit permission/context metadata and staged action plans. |
| [sitne/discord-agent](https://github.com/sitne/discord-agent) | MIT | [`tools_permissions.py`](https://github.com/sitne/discord-agent/blob/main/tools_permissions.py), [`cogs/scheduler.py`](https://github.com/sitne/discord-agent/blob/main/cogs/scheduler.py): requester-bound confirmation and persistent scheduler claim/retry patterns. |
| [Aero-Apex/Discord-AI-Template-Bot](https://github.com/Aero-Apex/Discord-AI-Template-Bot) | MIT | [`index.js`](https://github.com/Aero-Apex/Discord-AI-Template-Bot/blob/main/index.js): focused role/channel plan preview and confirmation UX. |
| [mastra-ai/mastra](https://github.com/mastra-ai/mastra) | GitHub reports `Other`; root license is Apache-2.0, while `ee/` uses the Mastra Enterprise License. | [Workflows](https://mastra.ai/docs/workflows/overview), [Suspend/Resume](https://mastra.ai/docs/workflows/suspend-and-resume): deterministic orchestration with durable pause/resume. No code imported. |
| [vercel/ai](https://github.com/vercel/ai) | GitHub reports `Other`; the `packages/ai` license is Apache-2.0. | [Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling), [Telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry): strict schemas, local tool approval distinction, and opt-in trace payload recording. |
| [langchain-ai/langgraphjs](https://github.com/langchain-ai/langgraphjs) | MIT | [Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence), [Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts): checkpoints, thread identity and resumable human gates. |
| [langfuse/langfuse](https://github.com/langfuse/langfuse) | GitHub reports `Other`; root is MIT with Enterprise-licensed `ee/` paths. | [Tracing](https://langfuse.com/docs/tracing), [Token/Cost Tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking): trace trees, provider usage, price versioning and privacy controls. |
| [discordjs/discord.js](https://github.com/discordjs/discord.js) | Apache-2.0 | [`SequentialHandler.ts`](https://github.com/discordjs/discord.js/blob/main/packages/rest/src/lib/handlers/SequentialHandler.ts): bucket queues and retry-after handling; [Components V2 docs](https://docs.discord.com/developers/components/reference). |
| [Androz2091/discord-giveaways](https://github.com/Androz2091/discord-giveaways) | MIT | [`src/Manager.js`](https://github.com/Androz2091/discord-giveaways/blob/master/src/Manager.js), [`src/Giveaway.js`](https://github.com/Androz2091/discord-giveaways/blob/master/src/Giveaway.js): persistent end-time recovery and unique entrant/winner logic. |

GitHub's `Other` metadata is not a license grant by itself. For those monorepos, license status depends on the actual package/path. No Mastra, Langfuse or giveaway implementation code was copied; Autocord's own license remains private/closed source.

## Applied Design

- Agent plans remain strict Zod data, not tool calls. OpenCode sessions deny every tool; application code alone can execute Discord effects.
- `src/agent/skills/registry.ts` is the allowlist for `panel.create`, `panel.edit`, `panel.workflow`, `resource.workflow`, `role.create`, `channel.create_category` and `channel.create_text`. Each entry carries an input schema, required permissions, target scope, risk, effects and approval metadata. Policy resolves the compiled panel mutation or each resource step through this registry before preview and again before execution.
- Agentcord Max accepts up to eight typed panel operations with dependency IDs, topologically orders them and compiles them against one guild-scoped panel snapshot. The approved artifact is the final strict `PanelPlan` plus the original workflow steps, both bound into a canonical approval hash. The workflow compiles to one panel mutation; it is not yet a cross-resource job graph.
- Agentcord Max also accepts up to eight role/category/text-channel creation steps. Category-to-text parent references are step-ID-bound, writes are sequential, each step is durable in `agent_job_steps`, and Discord permissions cannot be supplied by the model. Mixed resource and panel workflows are rejected so the approval target and compensating boundary stay explicit.
- Approval stays bound to guild, job, plan hash, expiry and, for edits, panel revision. PostgreSQL compare-and-swap plus advisory locking prevent replay and cross-process guild races.
- Giveaway entries use a unique `(giveaway_id,user_id)` key. Drawing completion, audit event and notification-outbox insertion commit together. Notification delivery retries with bounded exponential backoff. Delivery is at-least-once: a crash after Discord accepts a send but before the outbox acknowledgment can duplicate a result message.
- Existing panel state and revision snapshots are guild-scoped; no general chat transcript is sent to the model. Model/token/cost aggregates are stored per guild/job. Full prompt/response tracing is deliberately not enabled by default.
- Components V2 and Classic rendering are separate renderers. Discord's sticky V2 message flag is respected; existing panels cannot switch render modes after publication.

## v0.5 Phase 1 Core Workflow Addendum

- `interactiveWorkflowStepSchema` is the executable action allowlist. Phase 1 registers State get/set/increment/decrement/multiply/delete/reset/append/remove, Math add/subtract/multiply/divide/min/max/clamp, cryptographic Random integer/choice/weighted-choice, and persistent Collection add/remove/count/contains/list/rank/clear actions as Agent Skills and interpreter cases.
- State rows remain keyed by `(workflow_id, scope, scope_id, key)`. Numeric mutations use a PostgreSQL transaction advisory lock scoped to the full key, read/validate/update in one transaction, and enforce finite numeric bounds. Append/remove use the same key lock and a 1,000-item list cap.
- `workflow_collections` is guild-bound and references its owning Workflow with cascade cleanup. A unique `(workflow,scope,scope_id,collection,item_key)` index provides idempotent membership; a count index supports scoped reads. Adds serialize per Workflow and enforce configurable per-collection capacity, a 20,000-row Workflow cap, and an approximately 10 MiB item-payload cap. Scalar items only; rank is numeric-only.
- Conditions are a recursive declarative Zod DSL with depth 8 and 64-node bounds; no JavaScript execution is introduced. Numeric/string/state/list/role/permission/time/random/result leaves are composed through AND/OR/NOT. The Workflow interpreter resolves typed prior-step numeric results before arithmetic/state operations.
- PostgreSQL concurrency and capacity tests are in `src/features/workflows/data.integration.test.ts`; they execute only when `TEST_DATABASE_URL` is present. Unit coverage checks schema, nested conditions, and deterministic math/weighted selection. Database availability and live Discord execution still need independent verification.
- Phase 1 is complete. Phase 2-4 implementations and current remaining gaps are listed in the v0.5 addendum below; Phase 5 PostgreSQL/live Discord/scale verification remains environment-dependent.

## v0.5 Phase 2-4 Addendum

- The Interactive Workflow registry/interpreter now includes 61 typed executable actions. Message send/reply/DM/edit/delete/pin/unpin results are bound to `(guild,workflow,run,step,message)` records before later edit/delete/pin/unpin actions can resolve them. Gateway message/reaction handlers ignore Bot authors/users; Bot-caused Role updates have short-lived in-process event suppression.
- Member join/leave/role triggers require `ENABLE_GUILD_MEMBERS_INTENT=true` and the Developer Portal privileged intent. Message content templates require `ENABLE_MESSAGE_CONTENT_INTENT=true`; that intent is also off by default. Guild message/reaction intents are explicitly requested. Private-ticket Channels use fixed allow/deny presets for only View/Send/ReadHistory; no model-generated overwrites are accepted. The ticket member-to-channel key has a partial unique DB index and bounded per-Workflow cap.
- Channel/Role rename/delete paths resolve only DB-recorded Workflow ownership. Ticket close allows only the stored creator, the recorded staff Role, or a Guild manager. General destructive Channel actions recheck bot and actor permissions at execution. Role assignment remains permissionless-role-only with hierarchy checks.
- `workflow.wait` checkpoints trigger inputs, prior results, cursor and a versioned spec snapshot in `workflow_waits`; a lease-backed DB poller resumes due runs after restart. `schedule.at` computes weekly local occurrences from an explicit IANA zone, including DST boundaries. Workflow pause/resume preserves schedule and wait due times; disable/delete cancel them. Unchanged schedule definitions survive Workflow revision updates. Delete is a soft terminal state: tracked Roles/Channels remain for manual cleanup.
- Each run has a step-boundary wall-time budget, a 24-step Workflow cap, a five-message send budget, global concurrency and per-actor cooldown. Failed side-effect-free retries are bounded; after any ambiguous or committed side effect, runs enter `RECOVERY_REQUIRED` rather than replaying an entire graph. `when`-guarded steps provide branching; bounded loops, state.changed triggers and cancellation of an in-flight external Discord request are not implemented.
- Agentcord Max now performs a separate structured requirement extraction call and validates its target, required action/trigger names and selected invariants against the registry and generated Workflow. Unknown capabilities, schema-invalid extraction, target mismatch, and request-specific invariant gaps return clarification before approval. Deterministic checks cover point awards/debits, staff-only tickets, reaction thresholds, recruitment and Voice cleanup; full RPG combat/shop remains unimplemented.
- Phase 5 tests cover schema/conditions/math, A/C/E workflow-plan structure, B/D/F capability distinctions, safe permission preset bitfields, ticket-close boundaries, per-message vote partitioning logic, point debit PostgreSQL concurrency, collection uniqueness/capacity, and wait/message restart persistence. PostgreSQL integration tests remain conditional on `TEST_DATABASE_URL`; no representative load test or live Discord test-guild run is claimed.

## Patterns Not Adopted

- No `eval`, shell, arbitrary HTTP, arbitrary SQL or model-selected Discord route is available. Some reference bots expose these, or load skill code from GitHub; those mechanisms were rejected as incompatible with the closed executor boundary.
- No process-local job queue or JSON-file giveaway store is used as the source of truth. Their restart behavior is useful as a sketch, but does not coordinate multiple workers or atomically couple state and notifications.
- No open-ended autonomous agent loop or parallel side-effect execution was added. Mini produces one plan; Max uses a bounded typed same-panel workflow, followed by explicit approval and deterministic execution.
- No full LangGraph/Mastra/Langfuse runtime was added. PostgreSQL state transitions, audit/usage tables and the current Vercel AI SDK adapter meet the present scope without introducing another scheduler/storage plane.

## Max-Focused Source Review

### `discord-bot-agents`

The current `main` implementation follows message handler → context prefetch → JSON planner → sequential executor → summary. Its registry carries permission metadata, but parameters are described by a string DSL rather than runtime schemas; the planner truncates to five actions. `jobManager.js` accepts up to 50 targets and reports progress, but its queue and progress state are process-local. Retrying timed-out Discord actions can repeat a side effect because timeout does not cancel the original request. The repository currently has no runnable test suite. Useful pattern: separate plan/execution/summary and return per-action outcomes. Do not adopt the in-memory job manager, string parameter parser, or unapproved execution model.

### `discord-mcp`

The current middleware chain separates access evaluation, guild target resolution and payload confirmation. This makes the policy boundary auditable, but deployment mode matters: `advisory`/`warn` can continue after unknown evidence, whereas only an enforced mode fails closed. Approval ledger defaults to process memory; the optional HMAC file ledger is still a filesystem deployment design, not a distributed transaction store. Guild filtering applies to recognized guild-targeted tools; global/read/build tools may intentionally fall outside that boundary. Useful pattern: bind approval to canonical payload hash, target and one-time ID, then revalidate access before executing. Autocord already binds job/guild/hash/expiry/revision and uses a conditional DB claim; Max should retain that invariant for every workflow step.

### Mastra

Mastra is the strongest reference for Max workflow semantics: stable step identity, persisted run/step state, suspend data, resume payloads and explicit run ownership. A persisted checkpoint is not exactly-once execution; an external Discord action can complete before its result is committed. Mastra's `ee/` code is governed by its separate Enterprise License; Autocord borrows only the public architectural concepts and adds no Mastra runtime dependency.

### `dexel-base`

Dexel's registry associates tools with specialist/category/permission metadata and passes an explicit guild/user context. Its Action Plan stages moderation actions and presents them in a confirmation UI. One risk is that model filtering is not an execution authorization boundary; the executor must recheck permissions. Another is parallel `gather` of tool calls that share mutable staged-action context, which can race. Autocord deliberately uses a single DB-backed plan and serial executor today; any Max parallelism should be limited to independent read-only work, never Discord writes sharing a guild state snapshot.

## Agentcord Max Design Direction

Max emits bounded typed workflow envelopes, not a free-form agent loop:

1. Panel output is `{version, operations:[{id, action, dependsOn, ...typedFields}]}`; operations are limited to panel title/description/style and option add/remove/rename/label/emoji. Resource output is a separate role/category/text-channel workflow. Both reject unknown actions/fields, duplicate IDs, unresolved dependencies and cycles.
2. Panel edits receive one guild-scoped panel snapshot and expected revision. Resource targets are generated inside the authenticated guild; category references must point to a category-create step. The model cannot set role permissions, channel overwrites or arbitrary target IDs.
3. Preview includes each ordered operation and the compiled panel diff or exact resource create sequence. Approval binds the canonical final plan/workflow, guild, revision, step context, hash and expiry.
4. Resource steps are claimed/recorded in PostgreSQL and run sequentially. Completed resources are preserved if a later step fails; ambiguous effects go to `RECOVERY_REQUIRED` rather than replay. Durable resume/reconciliation UI remains future work.
5. Safe replanning after stale panel revision must create a new workflow and approval. Parallel execution remains limited to independent read-only work.
6. Usage records capture provider/model/token counts per job. Per-step timing/tracing and privacy-reviewed trace sampling remain future work.

At the time of this historical source review, the bounded same-panel and resource-create workflows executed under separate approval targets. v0.5 later added resource actions inside Interactive Workflows and DB-backed wait resumption; explicit in-flight external request cancellation and a general recovery UI remain unimplemented.

## Remaining Review Items

- Current registry includes generic Workflow Core, Discord message/channel/Role and gateway trigger actions. Role deletion, state.changed and loop constructs are not registered capabilities; the full RPG battle/shop system is not implemented.
- `RECOVERY_REQUIRED` jobs fail closed for that guild and require operator reconciliation; Discord state is not automatically guessed after an ambiguous network outcome.
- Outbox retries and database migrations are unit/type checked but have not been tested with injected PostgreSQL/Discord failures in CI. No test-guild end-to-end operation was performed as part of this source review.
- Long-term retention/deletion controls and model price snapshots need a separate product/privacy decision before broader rollout.
