// Spike: verify the Vercel AI SDK streams from Bedrock under this box's
// egress setup (USE_PROXY handling in lib/env) with inference-profile IDs.
// Run: bun run scripts/aisdk-spike.ts
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { streamText } from "ai";
import { env } from "../src/lib/env";

// The AI SDK provider doesn't walk the full AWS chain (SSO, ~/.aws) on its
// own the way AnthropicBedrock does — hand it the node default provider.
const bedrock = createAmazonBedrock({ region: env.AWS_REGION, credentialProvider: defaultProvider() });
const model = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

console.log(`streaming from ${model} in ${env.AWS_REGION}…`);
const started = Date.now();
const result = streamText({
  model: bedrock(model),
  prompt: "Reply with exactly: 'stream check ok' and then one short sentence about mornings.",
});

let first: number | null = null;
for await (const part of result.textStream) {
  if (first === null) first = Date.now() - started;
  process.stdout.write(part);
}
console.log(`\n\nTTFT ${first}ms, total ${Date.now() - started}ms`);
const usage = await result.usage;
console.log("usage:", JSON.stringify(usage));
