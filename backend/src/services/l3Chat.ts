import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { streamText, type ModelMessage } from "ai";
import { asc, eq } from "drizzle-orm";
import { db } from "../db";
import { chatMessage, chatSession, experiment } from "../db/schema";
import { env } from "../lib/env";
import { resolveModel } from "./agentRunner";
import { getConfig } from "./config";
import { getReview } from "./reviewWriteup";

// L3: Bedrock conversations, no tools — quick in-app chats that turn messy
// thoughts into material. The loop is the Vercel AI SDK; storage stays
// chatSession/chatMessage so the loop is swappable without changing what a
// conversation means. Execution NEVER happens here: finishing a session hands
// the transcript to purpose-specific service code.

// The AI SDK provider doesn't walk the full AWS chain on its own — hand it
// the node default provider (same chain AnthropicBedrock uses).
const bedrock = createAmazonBedrock({ region: env.AWS_REGION, credentialProvider: defaultProvider() });

export function getL3Session(sessionId: string) {
  const session = db.select().from(chatSession).where(eq(chatSession.id, sessionId)).get();
  if (!session) return null;
  const messages = db
    .select()
    .from(chatMessage)
    .where(eq(chatMessage.sessionId, sessionId))
    .orderBy(asc(chatMessage.createdAt))
    .all();
  return { session, messages };
}

// Purpose-specific system context, projected fresh per turn.
function systemFor(session: typeof chatSession.$inferSelect): string {
  const preamble = getConfig<string>("PROMPT.preamble");
  const prompt = getConfig<string>(`PROMPT.${session.purpose}`);
  let context = "";
  if (session.purpose === "review_interview" && session.experimentId) {
    const e = db.select().from(experiment).where(eq(experiment.id, session.experimentId)).get();
    if (e) {
      context = `\n\n# The experiment under review\n\ntitle: ${e.title}\nstatus: ${e.status}\nhypothesis: ${e.hypothesisMd ?? "?"}\nuser's end notes: ${e.outcomeMd ?? "(none)"}`;
      // The current draft, so questions target what's missing.
      const review = getReview(session.experimentId);
      if (review?.draftMd) context += `\n\n# Current draft writeup\n\n${review.draftMd}`;
    }
  }
  return `${preamble}\n\n${prompt}${context}`;
}

// One streamed turn: persist the user message now, the assistant message on
// finish. Returns the AI SDK Response (fetch-native — Hono returns it as-is).
export function streamTurn(sessionId: string, userText: string): Response {
  const found = getL3Session(sessionId);
  if (!found) throw new Error(`session ${sessionId} not found`);
  if (found.session.status !== "open") throw new Error(`session is ${found.session.status}`);

  db.insert(chatMessage).values({ sessionId, role: "user", content: userText }).run();

  const history: ModelMessage[] = [
    ...found.messages.map(m => ({ role: m.role, content: m.content }) as ModelMessage),
    { role: "user", content: userText },
  ];

  const result = streamText({
    model: bedrock(resolveModel()),
    system: systemFor(found.session),
    messages: history,
    onFinish: ({ text }) => {
      db.insert(chatMessage).values({ sessionId, role: "assistant", content: text }).run();
    },
  });
  return result.toUIMessageStreamResponse();
}
