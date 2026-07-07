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
  topK: boolean;
  transcript?: TranscriptMessage[];
}

export const CATEGORIES = ["dream-coach", "journal", "ideas"];

const convo = (
  date: string,
  title: string,
  slug: boolean,
  category: string | null,
  topK = false,
  transcript: TranscriptMessage[] = [],
): Conversation => ({ id: `convo-${nextId++}`, date, title, slug, category, topK, transcript });

const u = (text: string): TranscriptMessage => ({ role: "user", text });
const c = (text: string): TranscriptMessage => ({ role: "coach", text });

export const initialConversations: Conversation[] = [
  convo("07-05", "fear of wanting rant", true, "dream-coach", true, [
    u("I keep noticing I'm scared to even admit I want things. Like wanting is dangerous."),
    c("What happens in your body when you let yourself want something out loud?"),
    u("Tight chest. Then I immediately start hedging — 'it's fine either way'."),
    c("So the hedge is protection. What would a tiny, unhedged want sound like tonight?"),
    u("I want to make music people actually hear. There, I said it."),
  ]),
  convo("07-06", "continuity of self system", false, null, false, [
    u("I feel like a different person every morning. Yesterday's plans feel like someone else's."),
    c("What's one thread that survives the night — however small?"),
    u("Honestly? The notebook next to my bed. If it's written down, morning-me trusts it."),
    c("Then the notebook is your continuity system. What should evening-you write tonight?"),
  ]),
  convo("07-06", "comparing similar statements", false, null, false, [
    u("'I should sleep more' and 'I want to feel rested' — they feel completely different."),
    c("One is a rule, one is a desire. Which one gets you into bed?"),
    u("The rested one. Rules make me rebel against myself."),
  ]),
  convo("07-04", "recurring falling dream", true, "dream-coach", false, [
    u("Third falling dream this week. I wake up right before hitting the ground, heart racing."),
    c("What's falling in your waking life right now — anything you're bracing for?"),
    u("The song deadline I keep pushing. I guess I'm bracing for the flop."),
    c("The dream ends before impact. Maybe the flop is survivable too. What if you let one rough thing land?"),
  ]),
  convo("07-03", "late night spiral about deadlines", true, "journal", false, [
    u("It's 1am and I'm rewriting the same eight bars instead of sleeping. Again."),
    c("What are you hoping one more pass will change?"),
    u("That it stops being embarrassing. But it never feels done."),
    c("Done isn't a feeling you'll get at 1am. What's a rule you could hand to tomorrow-you instead?"),
    u("Maybe: when a loop hits 30 seconds, bounce it and walk away."),
  ]),
  convo("07-02", "lucid dreaming attempt log", false, null, false, [
    u("Tried the reality checks all day. No lucid dream, but I remembered two dreams fully."),
    c("Recall comes before lucidity. What made the difference last night?"),
    u("Phone stayed outside the bedroom, so I wrote the dream down before checking anything."),
  ]),
];

// proposed item derived from the given conversations (by index into initialConversations)
const derived = (text: string, ...convIndexes: number[]): Item => ({
  ...item(text),
  sources: convIndexes.map(i => initialConversations[i]!.id),
});

// pending review — 20 total
export const initialProposed: Record<CategoryKey, Item[]> = {
  goals: [
    derived("Feel rested on weekday mornings", 2),
    derived("Cut sleep latency to 15 minutes", 4),
    derived("Keep weekend wake time within 1 hour", 1),
    derived("Dream recall 3x per week", 5, 3),
    derived("Stop hitting snooze", 1),
    derived("Average sleep score above 80", 2),
    derived("One full recovery day per week", 4, 0),
  ],
  habits: [
    derived("No caffeine after 2pm", 4),
    derived("Stretch for 5 minutes before bed", 5),
    derived("Dim lights an hour before sleep", 4),
    derived("Write tomorrow's plan the night before", 1, 4),
    derived("Breathing exercise when waking at night", 3),
    derived("Same wake time every day", 1),
  ],
  environment: [
    derived("Lavender scent in bedroom", 5),
    derived("Heavier blanket in winter", 3),
    derived("Air purifier on low overnight", 2),
    derived("No work laptop in bedroom", 4, 5),
    derived("Warm-toned night lamp only", 4),
    derived("Keep water glass on nightstand", 5),
    derived("Declutter nightstand weekly", 1),
  ],
};
