// UI-layer labels. All data comes from the backend via src/lib/api.ts.

export const EXTRACTION_KIND_LABELS: Record<string, string> = {
  goal_talk: "goal",
  habit_talk: "habit",
  environment_talk: "environment",
  experience_talk: "experience",
  experiment_idea: "experiment idea",
  feeling: "feeling",
};

export const PROPOSAL_KIND_LABELS: Record<string, string> = {
  goal_create: "new goal",
  goal_update: "goal update",
  synthesis_update: "synthesis",
  habit_add: "habit (already true)",
  habit_update: "habit update",
  environment_add: "environment",
  environment_update: "environment update",
  experience_add: "experience",
  experiment_propose: "experiment candidate",
};
