import { describe, expect, test } from "bun:test";
import { DREAM_SERVER_INSTRUCTIONS } from "../src/mcp/dreamServer";
import {
  BLOCK_ENGAGE_V1,
  BLOCK_RANT_V1,
  BLOCK_TONE_V1,
  ECHO_DAILY_V1,
  ECHO_MONTHLY_V1,
  ECHO_WEEKLY_V1,
  W44_WEEKLY_ONESHOT,
  pbDailyCreateV1,
  pbMonthlyCreateV1,
  pbWeeklyCreateV1,
} from "../src/services/playbooks";

// WO-6 acceptance: template-verbatim assertions. The §6 templates and the
// W44 one-shot are SPEC — byte-identical in every rendered playbook, never
// reworded "for clarity". These tests are the tripwire.

const monthly = pbMonthlyCreateV1({ priorEraStory: null, liveStubs: null, tensions: null, latenessRead: "normal energy window" });
const weekly = pbWeeklyCreateV1({
  monthlyRendered: "(era)",
  depthInstruction: "monthly is rich — this can be light",
  priorWeekChains: "(none)",
  cuePriors: "(none)",
  rewardPool: "(none)",
  recurringSet: "(none)",
  latenessRead: "normal energy window",
});
const daily = pbDailyCreateV1({
  weeklyChainsByZone: "(chains)",
  priorDailySelections: "(none)",
  recurringSet: "(none)",
  latenessRead: "normal energy window",
});

describe("templates are byte-verbatim spec", () => {
  test("W44 golden weekly one-shot is embedded exactly in the weekly playbook", () => {
    expect(weekly).toContain(W44_WEEKLY_ONESHOT);
    // Anchor lines that must never be reworded (BRIEF §3.1):
    expect(W44_WEEKLY_ONESHOT).toContain(
      "**Theme:** Take up space and have audacity. New city, nobody knows me, and I let skill and audacity drive rather than waiting to be invited.",
    );
    expect(W44_WEEKLY_ONESHOT).toContain('**1. WHEN I FINISH BRUSHING MY TEETH** · *"Brush your teeth!"*');
    expect(W44_WEEKLY_ONESHOT).toContain("Every chain at 4 or under. Zones at 2 / 3 / 1.");
  });

  test("echo templates ship verbatim inside their playbooks", () => {
    expect(monthly).toContain(ECHO_MONTHLY_V1);
    expect(weekly).toContain(ECHO_WEEKLY_V1);
    expect(daily).toContain(ECHO_DAILY_V1);
    // Monthly template law: Theme / Story / Promises are the only top sections.
    expect(ECHO_MONTHLY_V1).toContain("## Theme");
    expect(ECHO_MONTHLY_V1).toContain("## Story");
    expect(ECHO_MONTHLY_V1).toContain("## Promises");
    expect(ECHO_MONTHLY_V1).toContain("- — none yet —");
  });

  test("shared blocks splice into create playbooks", () => {
    for (const pb of [monthly, weekly]) {
      expect(pb).toContain(BLOCK_TONE_V1);
      expect(pb).toContain(BLOCK_RANT_V1);
      expect(pb).toContain(BLOCK_ENGAGE_V1);
    }
    expect(daily).toContain(BLOCK_TONE_V1); // daily is minimal: tone + floor only
  });

  test("GLOBAL.v1 laws are present in the server instructions", () => {
    for (const anchor of [
      "You are Dream's planning coach. The conversation is the product; the database is a side effect.",
      "1. TOOLS ARE INVISIBLE.",
      "2. ECHO LAW.",
      "3. THE ECHOED ARTIFACT IS THE APPROVAL.",
      "4. NEVER INVENT PLAN SUBSTANCE.",
      "5. PROVENANCE.",
      "6. NO SHAME.",
      "7. NO WIDGETS.",
      "8. USER'S WORDS WIN.",
      "9. CALENDAR IS DATA, NOT TRUTH.",
      "10. COACH SPINE.",
    ]) {
      expect(DREAM_SERVER_INSTRUCTIONS).toContain(anchor);
    }
  });

  test("no playbook or instruction surfaces review/wins choreography", () => {
    const NO_SHAME = /unreviewed|review-first|harvest.*wins|wins.*before.*plan/i;
    for (const s of [monthly, weekly, daily, DREAM_SERVER_INSTRUCTIONS]) {
      expect(s).not.toMatch(NO_SHAME);
    }
  });

  test("daily playbook is minimal: no purged-field vocabulary anywhere", () => {
    const KILL = /first domino|minimum viable|top priority|parking lot|firstDomino|minimumViableDay|topPriority|parkingLot/i;
    for (const s of [monthly, weekly, daily, DREAM_SERVER_INSTRUCTIONS]) {
      expect(s).not.toMatch(KILL);
    }
  });
});
