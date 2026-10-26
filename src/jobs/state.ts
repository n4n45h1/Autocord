export const jobStates = ["PLANNING", "AWAITING_PANEL_SELECTION", "AWAITING_APPROVAL", "EXECUTING", "COMPLETED", "DENIED", "EXPIRED", "FAILED", "RECOVERY_REQUIRED"] as const;
export type JobState = typeof jobStates[number];
export const globalAiSlotStates = ["PLANNING"] as const;

export function occupiesGlobalAiSlot(state: string): boolean {
  return (globalAiSlotStates as readonly string[]).includes(state);
}

export function canTransition(from: JobState, to: JobState): boolean {
  const transitions: Record<JobState, JobState[]> = {
    PLANNING: ["AWAITING_PANEL_SELECTION", "AWAITING_APPROVAL", "FAILED"],
    AWAITING_PANEL_SELECTION: ["PLANNING", "DENIED", "EXPIRED"],
    AWAITING_APPROVAL: ["EXECUTING", "DENIED", "EXPIRED"],
    EXECUTING: ["COMPLETED", "FAILED", "RECOVERY_REQUIRED"],
    COMPLETED: [], DENIED: [], EXPIRED: [], FAILED: ["RECOVERY_REQUIRED"], RECOVERY_REQUIRED: [],
  };
  return transitions[from].includes(to);
}
