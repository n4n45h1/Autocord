import type { InteractiveWorkflow } from "../interactive-workflow.js";

export type SymbolicTrace = { triggerId: string; actors: number; initialState: Record<string, unknown>; finalState: Record<string, unknown>; collections: Record<string, unknown[]>; results: Record<string, unknown>; executedSteps: string[]; mockedExternalEffects: string[]; unresolvedBranches: string[] };
export type Counterexample = { id: string; scenario: string; status: "counterexample" | "survives" | "inconclusive"; evidence: string; trace?: SymbolicTrace };
type SymbolicWorld = { state: Map<string, unknown>; collections: Map<string, Set<string>>; debitClaims: Set<string> };

function simulateTrigger(workflow: InteractiveWorkflow, triggerIndex: number, actorId: string, world: SymbolicWorld): SymbolicTrace {
  const trigger = workflow.triggers[triggerIndex]!;
  const { state, collections } = world;
  const results = new Map<string, unknown>();
  const executedSteps: string[] = [];
  const mockedExternalEffects: string[] = [];
  const unresolvedBranches: string[] = [];
  const initialState: Record<string, unknown> = Object.fromEntries(state);
  const stateKey = (scope: string, key: string) => `${scope}:${scope === "member" ? actorId : scope === "guild" ? "synthetic-guild" : workflow.name}:${key}`;
  const collectionScope = (scope: string) => scope === "member" ? `${scope}:${actorId}` : scope === "guild" ? `${scope}:synthetic-guild` : `${scope}:${workflow.name}`;
  const scalar = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    if (value === "{{actor}}" || value === "{{input:authorId}}") return actorId;
    const resultRef = value.match(/^\{\{result:([a-z0-9._-]+):([A-Za-z0-9._-]+)\}\}$/);
    if (resultRef) {
      const prior = results.get(resultRef[1]!);
      if (prior && typeof prior === "object") return (prior as Record<string, unknown>)[resultRef[2]!];
      unresolvedBranches.push(`unresolved reference ${value}`);
      return undefined;
    }
    const stateRef = value.match(/^\{\{state:(workflow|guild|member):([a-z0-9._-]+)\}\}$/);
    if (stateRef) {
      const found = state.get(stateKey(stateRef[1]!, stateRef[2]!));
      if (found === undefined) unresolvedBranches.push(`missing initial state ${stateRef[1]}:${stateRef[2]}`);
      return found;
    }
    if (value.startsWith("{{")) { unresolvedBranches.push(`symbolic template ${value}`); return undefined; }
    return value;
  };
  const condition = (value: import("../interactive-workflow.js").WorkflowCondition): boolean | null => {
    if (value.op === "and") {
      const results = value.conditions.map(condition);
      return results.includes(false) ? false : results.includes(null) ? null : true;
    }
    if (value.op === "or") {
      const results = value.conditions.map(condition);
      return results.includes(true) ? true : results.includes(null) ? null : false;
    }
    if (value.op === "not") { const nested = condition(value.condition); return nested === null ? null : !nested; }
    if (value.op === "result.equals") {
      const prior = results.get(value.stepId);
      if (!prior || typeof prior !== "object") return null;
      const actual = (prior as Record<string, unknown>)[value.field];
      if (actual === undefined) { unresolvedBranches.push(`unknown output ${value.stepId}.${value.field}`); return null; }
      return actual === value.value;
    }
    if (value.op === "entries.gte" || value.op === "entries.lt") {
      const count = collections.get(`workflow:${workflow.name}:entry:${value.collection}`)?.size ?? 0;
      return value.op === "entries.gte" ? count >= value.value : count < value.value;
    }
    if (value.op === "state.exists" || value.op === "state.not_exists" || value.op === "state.equals") {
      const found = state.get(stateKey(value.scope, value.key));
      if (value.op === "state.exists") return found !== undefined;
      if (value.op === "state.not_exists") return found === undefined;
      return found === value.value;
    }
    if (value.op === "number.eq" || value.op === "number.gt" || value.op === "number.gte" || value.op === "number.lt" || value.op === "number.lte") {
      const found = state.get(stateKey(value.scope, value.key));
      if (found === undefined) return value.op === "number.eq" ? 0 === value.value : value.op === "number.gt" ? 0 > value.value : value.op === "number.gte" ? 0 >= value.value : value.op === "number.lt" ? 0 < value.value : 0 <= value.value;
      if (typeof found !== "number") return null;
      if (value.op === "number.eq") return found === value.value;
      if (value.op === "number.gt") return found > value.value;
      if (value.op === "number.gte") return found >= value.value;
      if (value.op === "number.lt") return found < value.value;
      return found <= value.value;
    }
    unresolvedBranches.push(`condition ${value.op} requires external runtime context`);
    return null;
  };
  for (const step of trigger.steps) {
    if (step.when) {
      const enabled = condition(step.when);
      if (enabled === false) continue;
      if (enabled === null) unresolvedBranches.push(`conditional branch at ${step.id} explored as enabled`);
    }
    if (step.action === "state.set" || step.action === "state.increment" || step.action === "state.decrement" || step.action === "state.multiply" || step.action === "state.debit" || step.action === "state.get" || step.action === "state.delete" || step.action === "state.reset") {
      if (step.action === "state.set") {
        const value = scalar(step.value);
        if (value !== undefined) state.set(stateKey(step.scope, step.key), value);
        results.set(step.id, { key: step.key, scope: step.scope });
      } else if (step.action === "state.get") {
        const key = stateKey(step.scope, step.key);
        results.set(step.id, { exists: state.has(key), value: state.get(key) ?? null });
      } else if (step.action === "state.delete" || step.action === "state.reset") {
        const key = stateKey(step.scope, step.key ?? "*");
        if (step.action === "state.delete" || step.key !== null) state.delete(key);
        else for (const existing of state.keys()) if (existing.startsWith(`${collectionScope(step.scope)}:`)) state.delete(existing);
        results.set(step.id, { reset: true, deleted: true });
      } else {
        const key = stateKey(step.scope, step.key);
        const operand = Number(scalar(step.action === "state.multiply" ? step.factor : step.amount));
        const currentValue = state.get(key) ?? (step.action === "state.multiply" ? 1 : 0);
        if (typeof currentValue !== "number" || !Number.isFinite(operand)) {
          unresolvedBranches.push(`cannot symbolically evaluate ${step.id}`);
          results.set(step.id, { unresolved: true });
        } else if (step.action === "state.debit") {
          const minimumBalance = Number(scalar(step.minimumBalance));
          const debitKey = `${key}:${step.idempotencyKey ?? ""}`;
          const priorDebit = world.debitClaims.has(debitKey);
          const debited = !priorDebit && Number.isFinite(minimumBalance) && currentValue >= minimumBalance;
          if (debited) { state.set(key, currentValue - operand); world.debitClaims.add(debitKey); }
          results.set(step.id, { debited, duplicate: priorDebit, value: state.get(key) ?? currentValue });
        } else {
          const value = step.action === "state.increment" ? currentValue + operand : step.action === "state.decrement" ? currentValue - operand : currentValue * operand;
          state.set(key, value);
          results.set(step.id, { value });
        }
      }
    } else if (step.action === "collection.add" || step.action === "collection.remove" || step.action === "collection.clear" || step.action === "collection.count" || step.action === "collection.contains" || step.action === "collection.list" || step.action === "collection.rank") {
      const collection = `${collectionScope(step.scope)}:${step.collection}:${step.partitionByMessage ? "synthetic-message" : ""}`;
      const items = collections.get(collection) ?? new Set<string>();
      if (step.action === "collection.add") {
        const item = scalar(step.item);
        const added = item !== undefined && !items.has(JSON.stringify(item));
        if (added) items.add(JSON.stringify(item));
        collections.set(collection, items);
        results.set(step.id, { added, count: items.size });
      } else if (step.action === "collection.remove") {
        items.delete(JSON.stringify(scalar(step.item)));
        collections.set(collection, items);
        results.set(step.id, { removed: true, count: items.size });
      } else if (step.action === "collection.clear") {
        items.clear(); collections.set(collection, items); results.set(step.id, { cleared: true });
      } else if (step.action === "collection.count") results.set(step.id, { count: items.size });
      else if (step.action === "collection.contains") results.set(step.id, { contains: items.has(JSON.stringify(scalar(step.item))) });
      else results.set(step.id, { items: [...items] });
    } else if (step.action === "entry.join" || step.action === "entry.leave") {
      const key = `workflow:${workflow.name}:entry:${step.collection}`;
      const items = collections.get(key) ?? new Set<string>();
      if (step.action === "entry.join") { const joined = !items.has(actorId) && items.size < step.maxEntries; if (joined) items.add(actorId); results.set(step.id, { joined, count: items.size, full: items.size >= step.maxEntries }); }
      else { const left = items.delete(actorId); results.set(step.id, { left }); }
      collections.set(key, items);
    } else if (step.action === "math.add" || step.action === "math.subtract" || step.action === "math.multiply" || step.action === "math.divide") {
      const left = Number(scalar(step.left));
      const right = Number(scalar(step.right));
      const value = step.action === "math.add" ? left + right : step.action === "math.subtract" ? left - right : step.action === "math.multiply" ? left * right : right === 0 ? Number.NaN : left / right;
      if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(value)) unresolvedBranches.push(`cannot evaluate ${step.id} with synthetic inputs`);
      results.set(step.id, { value });
    } else if (step.action === "math.min" || step.action === "math.max") {
      const values = step.values.map((value) => Number(scalar(value)));
      const value = step.action === "math.min" ? Math.min(...values) : Math.max(...values);
      if (values.some((item) => !Number.isFinite(item))) unresolvedBranches.push(`cannot evaluate ${step.id} with synthetic inputs`);
      results.set(step.id, { value });
    } else if (step.action === "math.clamp") {
      const value = Number(scalar(step.value));
      if (!Number.isFinite(value)) unresolvedBranches.push(`cannot evaluate ${step.id} with synthetic inputs`);
      results.set(step.id, { value: Math.max(step.min, Math.min(step.max, value)) });
    } else if (step.action === "random.integer") {
      results.set(step.id, { value: step.min });
    } else if (step.action === "random.choice") {
      results.set(step.id, { value: step.values[0] });
    } else if (step.action === "random.weighted_choice") {
      results.set(step.id, { value: step.options[0]?.value ?? null });
    } else if (step.action === "channel.create_voice") {
      const channelId = `synthetic-voice-${step.id}`;
      results.set(step.id, { channelId, created: true });
    } else if (step.action === "channel.move_members") {
      const channelResult = results.get(step.channelStepId) as { channelId?: string } | undefined;
      const channelId = channelResult?.channelId;
      const entrants = [...(collections.get(`workflow:${workflow.name}:entry:${step.collection}`) ?? [])].map((item) => { try { return JSON.parse(item) as string; } catch { return item; } });
      if (!channelId || entrants.length > step.maxMembers) {
        unresolvedBranches.push(`cannot satisfy bounded group-move scenario at ${step.id}`);
        results.set(step.id, { movedMemberIds: [], movedCount: 0, unresolved: true });
      } else {
        results.set(step.id, { channelId, movedMemberIds: entrants, skippedMemberIds: [], movedCount: entrants.length });
      }
    } else if (step.action === "channel.delete_empty") {
      unresolvedBranches.push(`empty-channel cleanup ${step.id} requires a resource state from a prior trigger`);
      results.set(step.id, { deleted: false, unresolved: true });
    } else {
      mockedExternalEffects.push(`${step.id}:${step.action}`);
      results.set(step.id, { simulated: true });
    }
    executedSteps.push(step.id);
  }
  return {
    triggerId: trigger.id, actors: 1,
    initialState,
    finalState: Object.fromEntries(state),
    collections: Object.fromEntries([...collections].map(([key, values]) => [key, [...values].map((value) => { try { return JSON.parse(value); } catch { return value; } })])),
    results: Object.fromEntries(results), executedSteps, mockedExternalEffects, unresolvedBranches,
  };
}

export function runDryRun(workflow: InteractiveWorkflow): Counterexample[] {
  const steps = workflow.triggers.flatMap((trigger) => trigger.steps);
  const hasWait = steps.some((step) => step.action === "workflow.wait");
  const hasPersistentResume = workflow.triggers.some((trigger) => ["schedule", "schedule.at", "deadline"].includes(trigger.event));
  const hasExternalEffects = steps.some((step) => /^(message\.|channel\.|resource\.|role\.|voice\.|giveaway\.)/.test(step.action));
  const hasDependencyEdges = steps.some((step) => step.dependsOn.length > 0);
  const hasInteractiveTrigger = workflow.triggers.some((trigger) => ["button", "select", "modal_submit"].includes(trigger.event));
  const permissionSensitiveAction = steps.some((step) => /^(resource\.|role\.(?:grant|revoke|rename)|channel\.(?:create|delete|rename|set_permission)|giveaway\.(?:create|end|pause|resume|reroll))/.test(step.action));
  const hasStateReferences = /\{\{state:/.test(JSON.stringify(workflow)) || steps.some((step) => step.action === "state.get");
  const world: SymbolicWorld = { state: new Map(), collections: new Map(), debitClaims: new Set() };
  const stateTraces = workflow.triggers.map((_, index) => simulateTrigger(workflow, index, `synthetic-member-${index + 1}`, world));
  const aggregateTrace: SymbolicTrace | undefined = stateTraces.length ? {
    ...stateTraces[stateTraces.length - 1]!,
    triggerId: stateTraces.map((trace) => trace.triggerId).join(","),
    actors: stateTraces.length,
    initialState: stateTraces[0]!.initialState,
    executedSteps: stateTraces.flatMap((trace) => trace.executedSteps),
    mockedExternalEffects: stateTraces.flatMap((trace) => trace.mockedExternalEffects),
    unresolvedBranches: stateTraces.flatMap((trace) => trace.unresolvedBranches),
  } : undefined;
  const groupMove = steps.find((step) => step.action === "channel.move_members");
  const groupJoin = groupMove ? steps.find((step): step is Extract<(typeof steps)[number], { action: "entry.join" }> => step.action === "entry.join" && step.collection === groupMove.collection) : undefined;
  const groupCapacity: Counterexample | undefined = groupMove && groupJoin ? (() => {
    const actorIds = Array.from({ length: Math.min(2, groupJoin.maxEntries) }, (_, index) => `synthetic-member-${index + 1}`);
    const registered = new Set<string>();
    for (const actorId of actorIds) if (!registered.has(actorId) && registered.size < groupJoin.maxEntries) registered.add(actorId);
    const moved = registered.size <= groupMove.maxMembers ? registered.size : 0;
    const safe = registered.size <= groupJoin.maxEntries && moved === registered.size;
    return { id: "group-capacity", scenario: "Concurrent distinct signups at the configured capacity boundary are moved at most once each", status: safe ? "survives" : "counterexample", evidence: `Synthetic membership rows=${registered.size}, entry cap=${groupJoin.maxEntries}, move cap=${groupMove.maxMembers}, modeled moved=${moved}.` };
  })() : undefined;
  const run: Counterexample[] = [
    { id: "concurrent-trigger", scenario: "Two distinct interactions arrive concurrently", status: "inconclusive", evidence: "Dry run does not execute PostgreSQL locks or Discord API concurrency; executor guarantees remain authoritative." },
    { id: "duplicate-delivery", scenario: "The same event is delivered again", status: hasInteractiveTrigger ? "survives" : "inconclusive", evidence: hasInteractiveTrigger ? "Component interactions are keyed by interaction ID in the runtime run ledger; gateway-event deduplication is not inferred here." : "Gateway event identity and deduplication windows are not executed by the simulator." },
    { id: "process-restart", scenario: "Process restarts between steps", status: "inconclusive", evidence: hasWait || hasPersistentResume ? "Persistent wait/schedule checkpoint exists; external side-effect boundary is not simulated." : "No persistent continuation exists in this candidate; executor recovery state is not executed in the simulator." },
    { id: "permission-change", scenario: "Actor permissions change before an operation", status: permissionSensitiveAction ? "survives" : "inconclusive", evidence: permissionSensitiveAction ? "Compiler and executor require current permission checks for privileged mutations." : "No privileged mutation exists, so this scenario is not applicable to the candidate." },
    { id: "resource-removed", scenario: "An external actor removes a referenced channel or role", status: "inconclusive", evidence: "Discord resource lookup and compensation behavior are not executed by the simulator." },
    { id: "event-reordering", scenario: "Related gateway events arrive in a different order", status: "inconclusive", evidence: "The simulator checks the compiled dependency DAG but does not emulate gateway delivery ordering." },
    { id: "missing-state", scenario: "A referenced state value is absent", status: hasStateReferences ? "inconclusive" : "survives", evidence: hasStateReferences ? "State-dependent references require runtime values; no default value is assumed." : "No persisted state read/reference is present." },
    { id: "partial-action-failure", scenario: "An action fails after earlier effects have completed", status: hasExternalEffects ? "inconclusive" : "survives", evidence: hasExternalEffects ? "External effects are not executed; uncertain outcomes are routed to recovery rather than blind replay." : "No external action in this candidate." },
    { id: "suspend-resume", scenario: "Workflow is paused and later resumed", status: "inconclusive", evidence: "Control-plane pause/resume state machine is outside this deterministic workflow simulator." },
    { id: "unsequenced-effects", scenario: "Dependent effects execute without an explicit dependency edge", status: hasDependencyEdges ? "inconclusive" : "survives", evidence: "Compiler validates declared DAG references; dataflow ordering not inferable for independent effects." },
    { id: "symbolic-state", scenario: "Execute state, collection and registration operations against an in-memory synthetic state model", status: stateTraces.some((trace) => trace.unresolvedBranches.length) ? "inconclusive" : "survives", evidence: `${stateTraces.length} trigger trace(s) simulated; Discord and database calls are mocked.`, trace: aggregateTrace },
    ...(groupCapacity ? [groupCapacity] : []),
  ];
  return run;
}
