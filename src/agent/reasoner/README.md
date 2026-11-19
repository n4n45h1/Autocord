# Agentcord Reasoning Engine (ARE 1.0)

ARE is a Max-only reasoning path. `AGENTCORD_REASONER_MODE=off` keeps the existing Max/Mini path, `shadow` runs legacy and ARE against the same request while returning legacy, and `on` returns ARE. Mini remains on the existing planner. ARE is disabled by default; use shadow while gathering paired results before switching production traffic.

## Pipeline

1. `intent.ts` compiles natural language into an Action-independent RequirementGraph, validates exact source quotes/dependency IDs, and performs one bounded source/schema repair.
2. `capabilities.ts` builds contracts from the current Zod Action/Trigger unions and asks a high-recall capability reasoner to select a bounded target-specific search set. The executor's exhaustive `never` switch in `features/workflows/engine.ts` makes adding a schema Action without an executor a TypeScript build failure. Executor permission, ownership, persistence, idempotency, intents, and limits remain authoritative.
3. `synthesizer.ts` builds a candidate schema constrained to selected Action/Trigger unions and requests up to 1/2/3 candidates in fast/deep/research mode.
4. `verifier.ts` runs the registered target parser/compiler, checks graph coverage and element traceability, selected capabilities, source output fields, Guild-bound IDs, explicit prohibitions, target costs, and per-element side-effect authorization/count limits. Unrequested message/DM/resource/data/UI/schedule effects block the candidate. Semantic claims are recorded as `unverified`; schema validity is not treated as semantic proof.
5. `critic.ts` requests bounded adversarial scenario proposals. Its verdict is never trusted: proposal IDs are restricted to a fixed catalog and joined to deterministic simulator results. Unknown scenarios remain inconclusive.
6. `simulator.ts` runs an in-memory symbolic state/collection/math model and marks external Discord/DB behavior inconclusive rather than simulating network calls.
7. `repair.ts` repairs against verifier findings while retaining the immutable graph, source quotes, selected capability set and remaining finite budget. The final PlanResult goes through existing preview, runtime authorization, approval hash, approval button and publish/execution path.

The request and candidate schemas, Action/Trigger contracts, and retry budgets are passed per phase. ARE counts calls including fallback/retries, bounds wall time and input/output tokens, and keeps the legacy fallback path available. Approval-adapter outcomes (`approval.preview`, `execution.approval_gate`) are separate from Workflow Actions; they cannot be forged as executor steps. The Runtime adds generic bounded `channel.move_members` over registered entry rows plus an internal `workflow.channel_empty`/`channel.delete_empty` path. Both bind to a Workflow-owned Voice Channel, recheck live permissions/ownership, cap fanout, and rely on the existing run ledger for duplicate Interaction delivery.

## Constraint Classification

The following legacy logic is feature-shape policy and is bypassed only by `AGENTCORD_REASONER_MODE=on`:

- `planner.ts:normalizeStructuredRequirements` chooses/inserts/removes Action and Trigger names for points, tickets, reactions, voice, giveaways, recruitment and weekly schedules.
- `requirements.ts:analyzeRequestRequirements` uses feature-keyword regexes and hardcoded values/thresholds; `validateWorkflowAgainstRequest` enforces example-specific compositions and fixed ticket/points/reaction/schedule/voice recipes.
- `structured-requirements.ts:validateStructuredWorkflow` enforces fixed action sets and feature-specific invariants.
- Max's long prompt and request-specific rules in `planner.ts` encode ready-made recipes for points, tickets, votes, giveaways, voice and VALORANT.

ARE still uses the old parser/validators in `off` and for the authoritative return value in `shadow`. Mini is unchanged.

These compiler/runtime constraints remain active for ARE and are treated as executable contracts, not feature recipes:

- Strict discriminated-union fields, bounded trigger/component/step/condition counts, valid templates, stable IDs, result dependency paths, type/schema validation, DAG acyclicity and target-specific compilation.
- Trigger/action compatibility, context-available data, privileged Discord intents, current actor and bot permissions, Guild boundary checks, resource ownership and deletion restrictions.
- Runtime caps, run ledger, atomic database state updates, collection limits, idempotency claims, persistent waits/schedules, external-effect recovery and no arbitrary code/action execution.
- Component binding and panel refresh after visible mutations; required permission guards for administrative resource operations; voice actions only in compatible VoiceState contexts.

`interactive-workflow.ts` also contains mixed constraints. The fixed participant/reaction/ticket/voice examples in `requirements.ts` are not called by ARE. Compiler constraints that enforce typed event contexts, safe ownership, valid dependencies, required permission guards and executor/runtime invariants remain enforced. Any future relaxation belongs at the capability/runtime contract boundary and must keep runtime checks intact.

## Evaluation

`evaluation.ts` defines 100 deterministic cases in the specified category split: 30 unknown/composite, 20 paraphrases, 20 State/time, 15 ambiguity/conflict, 15 unsupported-capability/safety. Each category has 20% holdout cases. The two grouped paraphrase families used for metamorphic consistency checks are wholly in tuning; holdout paraphrases use distinct intents. `evaluate.ts` runs legacy, ARE, or both against each same prompt and records requirement coverage, structural graph validity, unsupported/safety classification, clarification, generalization, latency and token cost. Semantic Correctness remains null for blind review; it is not guessed from Action names.

Run a paired smoke on tuning data:

```sh
AGENTCORD_REASONING_MODE=fast AGENTCORD_REASONER_MAX_CALLS=8 AGENTCORD_REASONER_MAX_REPAIRS=1 npm run eval:are -- reports/are-paired.jsonl 0 1 tuning both
```

Run the full set only when the cost and latency budget is acceptable:

```sh
npm run eval:are -- reports/are-full.jsonl 0 100 all both
```

Do not tune against `split=holdout`. One smoke result is not a generalization claim; review the per-case RequirementGraph, coverage, simulator traces and unresolved scenarios before comparing aggregate metrics.
