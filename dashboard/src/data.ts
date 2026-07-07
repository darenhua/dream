// UI-layer types. All data now comes from the backend via src/lib/api.ts;
// this file is types + labels only.

export type CategoryKey = "goals" | "habits" | "environment";

export interface Item {
  id: string;
  text: string;
  active?: boolean;
  // ids of the conversations this item was derived from
  sources?: string[];
}

export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  goals: "goals",
  habits: "habits",
  environment: "environment",
};

// Review screen buckets: the three item sections plus categorization filing.
export type ReviewKey = CategoryKey | "filing";

export interface Intention {
  when: string;
  then: string;
}

export interface TranscriptMessage {
  role: "user" | "coach";
  text: string;
}

export interface Conversation {
  id: string;
  date: string;
  title: string;
  slug: boolean;
  category: string | null;
  categoryId: string | null;
  linkId: string | null;
  topK: boolean;
}
