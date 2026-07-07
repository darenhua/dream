import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ParseError,
  detectSlug,
  parseConversation,
  reconstructActivePath,
} from "../src/domain/parser";

const SYNTHETIC = join(import.meta.dir, "fixtures/synthetic.json");
const REAL_EXPORT = join(import.meta.dir, "../../conversations.json"); // personal data, gitignored

describe("synthetic fixture", async () => {
  const fixture = (await Bun.file(SYNTHETIC).json()) as any[];
  const branched = fixture[0];

  test("active path drops the abandoned branch", () => {
    const parsed = parseConversation(branched);
    const contents = parsed.messages.map(m => m.content);
    expect(contents.some(c => c.includes("ABANDONED BRANCH"))).toBe(false);
    expect(parsed.messages).toHaveLength(6); // 7 raw messages, 1 abandoned
    expect(parsed.messages[1]!.content).toBe("What happens right before you avoid one?");
  });

  test("attachment extracted_content is appended in a marked block", () => {
    const parsed = parseConversation(branched);
    const withAttachment = parsed.messages[2]!;
    expect(withAttachment.content).toContain("Here's the email I never answered.");
    expect(withAttachment.content).toContain("[attachment: email.txt]");
    expect(withAttachment.content).toContain("Just checking in about the collab.");
  });

  test("slug detected on its own user message, with truncation index", () => {
    const parsed = parseConversation(branched);
    const { slugDetected, slugMessageIdx } = detectSlug(parsed.messages, "#DREAM-CATEGORIZE");
    expect(slugDetected).toBe(true);
    expect(slugMessageIdx).toBe(4);
    expect(parsed.messages[4]!.role).toBe("user");
  });

  test("slug embedded mid-text does not match (exact-match contract, A5)", () => {
    const messages = [
      { role: "user" as const, content: "#DREAM-CATEGORIZE please", ts: null },
      { role: "user" as const, content: "  #DREAM-CATEGORIZE  ", ts: null }, // trimmed exact → match
    ];
    const result = detectSlug(messages, "#DREAM-CATEGORIZE");
    expect(result.slugMessageIdx).toBe(1);
  });

  test("broken parent chain fails loudly with the conversation uuid", () => {
    expect(() => parseConversation(fixture[1])).toThrow(ParseError);
    try {
      parseConversation(fixture[1]);
    } catch (e) {
      expect((e as ParseError).externalId).toBe("synthetic-broken-0002");
      expect((e as ParseError).reason).toContain("broken parent chain");
    }
  });
});

describe.skipIf(!existsSync(REAL_EXPORT))("real export fixture", async () => {
  const real = existsSync(REAL_EXPORT) ? ((await Bun.file(REAL_EXPORT).json()) as any[]) : [];

  test("every conversation parses", () => {
    for (const raw of real) {
      const parsed = parseConversation(raw);
      expect(parsed.externalId).toBeTruthy();
      expect(parsed.messages.length).toBeGreaterThan(0);
    }
  });

  test("branched conversation resolves to a strictly linear active path", () => {
    let sawBranch = false;
    for (const raw of real) {
      const parents = raw.chat_messages.map((m: any) => m.parent_message_uuid);
      const hasBranch = new Set(parents).size !== parents.length;
      if (!hasBranch) continue;
      sawBranch = true;
      const path = reconstructActivePath(raw.chat_messages);
      expect(path.length).toBeLessThan(raw.chat_messages.length); // branches dropped
      for (let i = 1; i < path.length; i++) {
        expect(path[i]!.parent_message_uuid).toBe(path[i - 1]!.uuid); // linear chain
      }
    }
    expect(sawBranch).toBe(true); // the real export is known to contain a branch point
  });
});
