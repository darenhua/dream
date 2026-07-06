export type CategoryKey = "goals" | "habits" | "environment";

export interface Item {
  id: string;
  text: string;
  active?: boolean;
}

export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  goals: "goals",
  habits: "habits",
  environment: "environment",
};

let nextId = 0;
const item = (text: string, active = false): Item => ({
  id: `item-${nextId++}`,
  text,
  active,
});

export const initialItems: Record<CategoryKey, Item[]> = {
  goals: [
    item("Fall asleep within 20 minutes", true),
    item("Sleep 7.5 hours per night"),
    item("Wake up without an alarm"),
  ],
  habits: [
    item("No screens after 10pm", true),
    item("Journal before bed"),
    item("Morning sunlight walk"),
  ],
  environment: [
    item("Bedroom at 18°C"),
    item("Blackout curtains closed"),
    item("Phone charges outside bedroom"),
  ],
};

// "proposed and accepted" pool shown in the edit sheet
export const initialAccepted: Record<CategoryKey, Item[]> = {
  goals: [item("Consistent bedtime by 11pm"), item("Reduce night wake-ups")],
  habits: [item("Read 10 pages before sleep")],
  environment: [item("White noise machine on")],
};

export interface Intention {
  when: string;
  then: string;
}

export interface Experiment {
  title: string;
  daysRunning: number;
  intentions: Intention[]; // 1-3 implementation intentions
  quote: { text: string; author: string };
}

export const experiment: Experiment = {
  title: "Ship one rough song publicly",
  daysRunning: 4,
  intentions: [
    { when: "I close my laptop after work", then: "open Ableton for 10 min" },
    { when: "a loop is 30 seconds long", then: "bounce it, no more tweaking" },
    { when: "it's Sunday 18:00", then: "post the roughest take publicly" },
  ],
  quote: {
    text: "Perfectionism is the voice of the oppressor, the enemy of the people.",
    author: "Anne Lamott",
  },
};

export interface Conversation {
  id: string;
  date: string;
  title: string;
  slug: boolean;
  category: string | null;
  topK: boolean;
}

export const CATEGORIES = ["dream-coach", "journal", "ideas"];

const convo = (
  date: string,
  title: string,
  slug: boolean,
  category: string | null,
  topK = false,
): Conversation => ({ id: `convo-${nextId++}`, date, title, slug, category, topK });

export const initialConversations: Conversation[] = [
  convo("07-05", "fear of wanting rant", true, "dream-coach", true),
  convo("07-06", "continuity of self system", false, null),
  convo("07-06", "comparing similar statements", false, null),
  convo("07-04", "recurring falling dream", true, "dream-coach"),
  convo("07-03", "late night spiral about deadlines", true, "journal"),
  convo("07-02", "lucid dreaming attempt log", false, null),
];

// pending review — 20 total
export const initialProposed: Record<CategoryKey, Item[]> = {
  goals: [
    item("Feel rested on weekday mornings"),
    item("Cut sleep latency to 15 minutes"),
    item("Keep weekend wake time within 1 hour"),
    item("Dream recall 3x per week"),
    item("Stop hitting snooze"),
    item("Average sleep score above 80"),
    item("One full recovery day per week"),
  ],
  habits: [
    item("No caffeine after 2pm"),
    item("Stretch for 5 minutes before bed"),
    item("Dim lights an hour before sleep"),
    item("Write tomorrow's plan the night before"),
    item("Breathing exercise when waking at night"),
    item("Same wake time every day"),
  ],
  environment: [
    item("Lavender scent in bedroom"),
    item("Heavier blanket in winter"),
    item("Air purifier on low overnight"),
    item("No work laptop in bedroom"),
    item("Warm-toned night lamp only"),
    item("Keep water glass on nightstand"),
    item("Declutter nightstand weekly"),
  ],
};
