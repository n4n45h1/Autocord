import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { generateOpenCodePlan } from "../opencode.js";
import { compileInteractiveWorkflow } from "../interactive-workflow.js";
import { compileMaxWorkflow, maxWorkflowSchema } from "../workflow.js";
import type { PanelPlan } from "../plan.js";
import type { PlanResult } from "../planner.js";
import { reasonCapabilities } from "./capabilities.js";
import { compileIntent, requirementGraphSchema, type ModelCall, type ReasoningBackend, type RequirementGraph } from "./intent.js";
import { repairCandidate } from "./repair.js";
import { confirmCounterexampleProposals, proposeCounterexamples } from "./critic.js";
import { synthesizeCandidates, type WorkflowCandidate } from "./synthesizer.js";
import { verifyCandidate, type VerificationContext, type VerificationResult } from "./verifier.js";

type Mode = "fast" | "deep" | "research";
type FailureClass = "missing_capability" | "missing_information" | "conflicting_requirements" | "unsafe_request" | "invalid_candidate" | "verification_inconclusive";

const provider = createOpenAI({ baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL ?? "https://api.opencode.ai/v1", apiKey: process.env.OPENAI_COMPATIBLE_API_KEY ?? "" });

function chooseMode(configured: string, graph: RequirementGraph): Mode {
  if (configured === "fast" || configured === "deep" || configured === "research") return configured;
  const hardRequirements = graph.requirements.filter((requirement) => requirement.importance === "hard");
  const dependencyEdges = graph.requirements.reduce((sum, requirement) => sum + requirement.dependsOn.length, 0);
  const unknownCount = graph.requirements.filter((requirement) => requirement.missingInformation.length > 0).length;
  if (graph.contradictions.length || unknownCount >= 2 || hardRequirements.length >= 12) return "research";
  if (hardRequirements.length >= 4 || dependencyEdges >= 3 || unknownCount > 0) return "deep";
  return "fast";
}

function failureClass(graph: RequirementGraph, verification?: VerificationResult): FailureClass {
  if (graph.contradictions.length) return "conflicting_requirements";
  if (graph.requirements.some((requirement) => requirement.missingInformation.length)) return "missing_information";
  if (graph.target === "unsupported_or_unclear") return "missing_information";
  if (verification?.issues.length) return "invalid_candidate";
  if (verification?.unresolved.length) return "verification_inconclusive";
  return "invalid_candidate";
}

function classifyPlannerError(error: unknown): FailureClass {
  const message = error instanceof Error ? error.message : String(error);
  if (/budget|abort|timed? out|timeout/i.test(message)) return "verification_inconclusive";
  return "invalid_candidate";
}

function candidateCost(candidate: WorkflowCandidate, verification: VerificationResult): number {
  const workflow = candidate.target === "interactive" ? compileInteractiveWorkflow(candidate.workflow) : null;
  const effectSteps = workflow?.triggers.flatMap((trigger) => trigger.steps).filter((step) => /^(message\.|channel\.|role\.|resource\.|voice\.|giveaway\.)/.test(step.action)).length ?? verification.cost.actionCount;
  return verification.cost.actionCount * 3 + verification.cost.triggerCount * 2 + verification.cost.dependencyEdges + effectSteps * 5 + verification.unresolved.length * 8;
}

export type ReasonerOptions = {
  existingPanel?: PanelPlan;
  existingWorkflow?: import("../interactive-workflow.js").InteractiveWorkflow;
  existingWorkflowId?: string;
  existingWorkflowVersion?: number;
  availableManagedRoles?: string[];
  availableVoiceChannels?: { id: string; name: string; category: string | null }[];
  availableStaffRoles?: { id: string; name: string }[];
  availableChannelIds?: string[];
  call?: ModelCall;
};

export async function makeReasonerPlan(request: string, mode: "mini" | "max", options: ReasonerOptions = {}): Promise<PlanResult> {
  if (mode !== "max") throw new Error("Reasoning Engine is available only for Agentcord Max.");
  const started = Date.now();
  const timeoutMs = boundedInteger(process.env.AGENTCORD_REASONER_TIMEOUT_MS, 90_000, 10_000, 180_000);
  const perCallTimeoutMs = boundedInteger(process.env.AGENTCORD_REASONER_CALL_TIMEOUT_MS, 30_000, 5_000, 60_000);
  const deadline = started + timeoutMs;
  const configuredReasoningMode = process.env.AGENTCORD_REASONING_MODE ?? "auto";
  const model = process.env.AGENTCORD_MAX_MODEL ?? process.env.OPENCODE_MODEL_MAX ?? "river/deepseek-v4.1-flash";
  const fallback = process.env.AI_FALLBACK_MODEL;
  const backend = (process.env.AI_BACKEND ?? "opencode-server") as ReasoningBackend;
  const callLimit = boundedInteger(process.env.AGENTCORD_REASONER_MAX_CALLS, 8, 2, 12);
  const inputTokenLimit = boundedInteger(process.env.AGENTCORD_REASONER_INPUT_TOKENS, 120_000, 10_000, 120_000);
  const outputTokenLimit = boundedInteger(process.env.AGENTCORD_REASONER_OUTPUT_TOKENS, 16_000, 2_000, 32_000);
  const candidateLimit = boundedInteger(process.env.AGENTCORD_REASONER_MAX_CANDIDATES, 3, 1, 3);
  const repairLimit = boundedInteger(process.env.AGENTCORD_REASONER_MAX_REPAIRS, 2, 0, 4);
  const diagnostics: Record<string, unknown> = { engine: "ARE-1.0", reasoningMode: configuredReasoningMode, limits: { timeoutMs, perCallTimeoutMs, callLimit, inputTokenLimit, outputTokenLimit, candidateLimit, repairLimit }, calls: 0, candidates: [], verification: [], unresolved: [] };
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let latestModel = model;
  const invoke: ModelCall = async (prompt, schema, maxOutputTokens) => {
    if (calls >= callLimit) throw new Error("Reasoning call budget exhausted.");
    calls++;
    const remaining = Math.min(deadline - Date.now(), perCallTimeoutMs);
    if (remaining <= 0) throw new Error("Reasoning wall-clock budget exhausted.");
    const estimatedInput = Math.ceil(prompt.length / 3.5);
    if (estimatedInput + inputTokens >= inputTokenLimit) throw new Error("Reasoning estimated input-token budget exhausted before model call.");
    const remainingInput = inputTokenLimit - inputTokens;
    const outputRemaining = outputTokenLimit - outputTokens;
    if (outputRemaining <= 0) throw new Error("Reasoning output-token budget exhausted.");
    const boundedOutput = Math.min(maxOutputTokens, outputRemaining);
    const run = async (modelName: string) => {
      if (options.call) return options.call(prompt, schema, boundedOutput);
      if (backend === "opencode-server") return generateOpenCodePlan(prompt, modelName, remaining);
      if (backend !== "openai-compatible") throw new Error(`Unsupported AI_BACKEND: ${backend}`);
      const result = await generateObject({ model: provider(modelName), schema, prompt, temperature: 0, maxOutputTokens: boundedOutput, abortSignal: AbortSignal.timeout(remaining) });
      return { object: result.object, model: result.response.modelId, inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 };
    };
    let result;
    try { result = await run(model); }
    catch (error) {
      const failed = error as { model?: string; inputTokens?: number; outputTokens?: number };
      if (Number.isFinite(failed.inputTokens)) inputTokens += failed.inputTokens!;
      if (Number.isFinite(failed.outputTokens)) outputTokens += failed.outputTokens!;
      if (failed.model) latestModel = failed.model;
      if (!fallback || fallback === model || calls >= callLimit || (error as { status?: number }).status === 429 || Date.now() >= deadline) throw error;
      calls++;
      result = await run(fallback);
    }
    if (result.outputTokens > outputRemaining) throw new Error("Reasoning output-token budget exceeded by model response.");
    latestModel = result.model;
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;
    if (inputTokens > inputTokenLimit || result.inputTokens > remainingInput) throw new Error("Reasoning input-token budget exceeded by model response.");
    return result;
  };

  let graph: RequirementGraph;
  try {
    const targetHint = options.existingWorkflow ? "interactive" : options.existingPanel ? "panel" : undefined;
    const existingSpec = options.existingWorkflow ?? options.existingPanel;
    const intent = await compileIntent(request, invoke, 2, { ...(targetHint ? { targetHint } : {}), ...(existingSpec ? { existingSpec } : {}) });
    graph = intent.graph;
    diagnostics.intentAttempts = intent.attempts;
  } catch (error) {
    const failure = classifyPlannerError(error);
    diagnostics.failureClass = failure;
    diagnostics.calls = calls;
    diagnostics.intentError = error instanceof Error ? error.message : String(error);
    diagnostics.intentResponsePreview = "responsePreview" in (error as object) ? (error as { responsePreview?: string }).responsePreview : undefined;
    return { plan: null, model: latestModel, inputTokens, outputTokens, clarification: { questions: [error instanceof Error ? error.message : String(error)], missingSkills: [] }, diagnostics: { reasoner: diagnostics } };
  }
  diagnostics.requirementGraph = graph;
  if (graph.contradictions.length || graph.requirements.some((requirement) => requirement.missingInformation.length)) {
    diagnostics.failureClass = failureClass(graph);
    diagnostics.requirementStatus = graph.requirements.map((requirement) => ({
      requirementId: requirement.id,
      status: graph.contradictions.some((contradiction) => contradiction.requirements.includes(requirement.id)) ? "conflicting_requirements" : requirement.missingInformation.length ? "needs_information" : "candidate_search_pending",
    }));
    diagnostics.contradictions = graph.contradictions;
    return { plan: null, model: latestModel, inputTokens, outputTokens, clarification: { questions: [...graph.contradictions.map((item) => item.explanation), ...graph.requirements.flatMap((item) => item.missingInformation)].slice(0, 5), missingSkills: [] }, diagnostics: { reasoner: diagnostics } };
  }
  if (graph.target === "unsupported_or_unclear") {
    diagnostics.failureClass = "missing_information";
    return { plan: null, model: latestModel, inputTokens, outputTokens, clarification: { questions: ["Requested output target could not be resolved from the request."], missingSkills: [] }, diagnostics: { reasoner: diagnostics } };
  }
  const reasoningMode = chooseMode(configuredReasoningMode, graph);
  const maxCandidates = reasoningMode === "fast" ? 1 : reasoningMode === "deep" ? Math.min(2, candidateLimit) : candidateLimit;
  const maxRepairs = reasoningMode === "fast" ? Math.min(1, repairLimit) : repairLimit;
  diagnostics.reasoningMode = reasoningMode;
  diagnostics.limits = { timeoutMs, perCallTimeoutMs, callLimit, inputTokenLimit, outputTokenLimit, maxCandidates, maxRepairs };
  const target = graph.target;
  let selectedCapabilities: Awaited<ReturnType<typeof reasonCapabilities>>;
  try {
    selectedCapabilities = await reasonCapabilities(graph, target, invoke);
  } catch (error) {
    diagnostics.failureClass = classifyPlannerError(error);
    diagnostics.calls = calls;
    diagnostics.capabilityError = error instanceof Error ? error.message : String(error);
    return { plan: null, model: latestModel, inputTokens, outputTokens, clarification: { questions: [error instanceof Error ? error.message : String(error)], missingSkills: [] }, diagnostics: { reasoner: diagnostics } };
  }
  const permittedCapabilities = new Set([...selectedCapabilities.actions.map((capability) => `action:${capability.name}`), ...selectedCapabilities.triggers.map((trigger) => `trigger:${trigger.name}`)]);
  diagnostics.capabilityCount = selectedCapabilities.actions.length;
  diagnostics.triggerCapabilityCount = selectedCapabilities.triggers.length;
  diagnostics.requirementStatus = graph.requirements.map((requirement) => ({
    requirementId: requirement.id,
    status: requirement.missingInformation.length ? "needs_information" : selectedCapabilities.unsafeRequirements.some((item) => item.requirementId === requirement.id) ? "unsafe_request" : "candidate_search_pending",
  }));
  diagnostics.unsupportedHypotheses = selectedCapabilities.unsupportedRequirements;
  if (selectedCapabilities.unsafeRequirements.length) {
    diagnostics.failureClass = "unsafe_request";
    diagnostics.unsafeRequirements = selectedCapabilities.unsafeRequirements;
    diagnostics.calls = calls;
    diagnostics.elapsedMs = Date.now() - started;
    return { plan: null, model: latestModel, inputTokens, outputTokens, clarification: { questions: selectedCapabilities.unsafeRequirements.map((item) => `${item.requirementId}: ${item.explanation}`).slice(0, 5), missingSkills: [] }, diagnostics: { reasoner: diagnostics } };
  }
  const verificationContext: VerificationContext = { managedRoles: options.availableManagedRoles, staffRoleIds: options.availableStaffRoles?.map((role) => role.id), channelIds: options.availableChannelIds, voiceChannelIds: options.availableVoiceChannels?.map((channel) => channel.id) };
  const synthesisContext = { managedRoles: options.availableManagedRoles ?? [], voiceChannels: options.availableVoiceChannels ?? [], staffRoles: options.availableStaffRoles ?? [], channelIds: options.availableChannelIds ?? [], existingWorkflow: options.existingWorkflow ?? null, existingPanel: options.existingPanel ?? null };
  diagnostics.context = synthesisContext;
  const accepted: { candidate: WorkflowCandidate; verification: VerificationResult; score: number }[] = [];
  let repairCount = 0;
  let lastVerification: VerificationResult | undefined;
  let candidates: WorkflowCandidate[] = [];
  try {
    const synthesized = await synthesizeCandidates(graph, selectedCapabilities.actions, selectedCapabilities.triggers.map((trigger) => ({ name: trigger.name })), invoke, maxCandidates, 0, synthesisContext);
    candidates = synthesized.candidates.slice(0, maxCandidates);
  } catch (error) {
    (diagnostics.candidates as unknown[]).push({ error: error instanceof Error ? error.message : String(error) });
  }
  for (let candidateIndex = 0; candidateIndex < candidates.length && Date.now() < deadline; candidateIndex++) {
    let candidate = candidates[candidateIndex]!;
    if (candidate.target !== target) {
      (diagnostics.candidates as unknown[]).push({ index: candidateIndex, rejected: `candidate target ${candidate.target} conflicts with intent target ${target}` });
      continue;
    }
    for (let repairIndex = 0; repairIndex <= maxRepairs && Date.now() < deadline && calls < callLimit; repairIndex++) {
      const verification = verifyCandidate(graph, candidate, permittedCapabilities, verificationContext);
      lastVerification = verification;
      if (verification.valid && candidate.target === "interactive") {
        if (calls >= callLimit || Date.now() >= deadline) {
          verification.valid = false;
          verification.issues.push("Adversarial critic budget exhausted before candidate acceptance.");
          verification.unresolved.push("adversarial-critic-budget");
        } else {
          try {
            const candidateWorkflow = (verification.workflow as { workflow: ReturnType<typeof compileInteractiveWorkflow> }).workflow;
            const proposals = await proposeCounterexamples(graph, candidateWorkflow, invoke);
            const confirmed = confirmCounterexampleProposals(candidateWorkflow, proposals);
            const scenarios = new Map(verification.scenarios.map((scenario) => [scenario.id, scenario]));
            for (const scenario of confirmed.scenarios) scenarios.set(scenario.id, scenario);
            verification.scenarios = [...scenarios.values()];
            verification.unresolved = [...new Set([...verification.unresolved, ...confirmed.scenarios.filter((scenario) => scenario.status === "inconclusive").map((scenario) => scenario.id)])];
            if (confirmed.counterexamples.length) {
              verification.valid = false;
              verification.issues.push(...confirmed.counterexamples.map((scenario) => `${scenario.id}: ${scenario.evidence}`));
            }
            (diagnostics as Record<string, unknown>).criticProposals = proposals;
          } catch (error) {
            verification.valid = false;
            verification.issues.push(`Adversarial critic did not produce verifiable test proposals: ${error instanceof Error ? error.message : String(error)}`);
            verification.unresolved.push("adversarial-critic-inconclusive");
          }
        }
      }
      (diagnostics.verification as unknown[]).push(verification);
      if (verification.valid && !verification.coverage.some((item) => item.status === "uncovered" && graph.requirements.find((req) => req.id === item.requirementId)?.importance === "hard")) {
        accepted.push({ candidate, verification, score: candidateCost(candidate, verification) });
        break;
      }
      if (repairIndex === maxRepairs || repairCount >= maxRepairs || calls >= callLimit) break;
      try {
        const repaired = await repairCandidate(graph, candidate, verification.issues.length ? verification.issues : ["Hard requirement coverage is incomplete."], selectedCapabilities.actions, selectedCapabilities.triggers.map((trigger) => ({ name: trigger.name })), { callsRemaining: callLimit - calls, repairsRemaining: maxRepairs - repairCount, millisecondsRemaining: deadline - Date.now() }, invoke);
        candidate = repaired.candidate;
        repairCount++;
      } catch (error) {
        (diagnostics.candidates as unknown[]).push({ index: candidateIndex, repairError: error instanceof Error ? error.message : String(error) });
        break;
      }
    }
    (diagnostics.candidates as unknown[]).push({ index: candidateIndex, accepted: accepted.some((item) => item.candidate === candidate), actions: lastVerification?.cost.actionCount });
  }
  diagnostics.calls = calls;
  diagnostics.repairs = repairCount;
  diagnostics.elapsedMs = Date.now() - started;
  if (!accepted.length) {
    const candidateErrors = diagnostics.candidates as { error?: string; repairError?: string }[];
    const budgetExhausted = Date.now() >= deadline || calls >= callLimit || inputTokens >= inputTokenLimit || outputTokens >= outputTokenLimit || candidateErrors.some((item) => /abort|budget|timeout|timed out/i.test(`${item.error ?? ""} ${item.repairError ?? ""}`));
    const hardUnsupported = selectedCapabilities.unsupportedRequirements.some((item) => graph.requirements.some((requirement) => requirement.id === item.requirementId && requirement.importance === "hard")
      && (!lastVerification || lastVerification.coverage.some((entry) => entry.requirementId === item.requirementId && entry.status === "uncovered")));
    diagnostics.failureClass = budgetExhausted ? "verification_inconclusive" : hardUnsupported ? "missing_capability" : failureClass(graph, lastVerification);
    diagnostics.partialCoverage = lastVerification?.coverage;
    diagnostics.sideEffects = lastVerification?.sideEffects ?? [];
    diagnostics.unresolved = lastVerification?.unresolved ?? [];
    return { plan: null, model: latestModel, inputTokens, outputTokens, clarification: { questions: (lastVerification?.issues ?? ["No candidate satisfied the hard requirements within the reasoning budget."]).slice(0, 5), missingSkills: [] }, diagnostics: { reasoner: diagnostics } };
  }
  accepted.sort((left, right) => left.score - right.score);
  const best = accepted[0]!;
  diagnostics.failureClass = null;
  diagnostics.selectedScore = best.score;
  diagnostics.unresolved = best.verification.unresolved;
  diagnostics.semanticChecks = best.verification.semanticChecks;
  diagnostics.coverage = best.verification.coverage;
  diagnostics.sideEffects = best.verification.sideEffects;
  const base = { plan: null, model: latestModel, inputTokens, outputTokens, diagnostics: { reasoner: diagnostics } };
  if (best.candidate.target === "interactive") return {
    ...base, interactiveWorkflow: best.verification.workflow as ReturnType<typeof compileInteractiveWorkflow>,
    ...(options.existingWorkflowId ? { interactiveWorkflowId: options.existingWorkflowId, expectedWorkflowVersion: options.existingWorkflowVersion } : {}),
  };
  if (best.candidate.target === "resources") {
    const workflow = best.verification.workflow as { workflow: { steps: PlanResult["resourceSteps"] } };
    return { ...base, resourceSteps: workflow.workflow.steps };
  }
  const workflow = maxWorkflowSchema.parse(best.verification.workflow && typeof best.verification.workflow === "object" && "workflow" in best.verification.workflow
    ? (best.verification.workflow as { workflow: unknown }).workflow : best.verification.workflow);
  return { ...base, plan: compileMaxWorkflow(options.existingPanel, workflow) };
}

function boundedInteger(value: string | undefined, fallbackValue: number, min: number, max: number): number {
  const number = Number(value ?? fallbackValue);
  return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallbackValue;
}

export const reasonerSchemas = { requirementGraphSchema };
