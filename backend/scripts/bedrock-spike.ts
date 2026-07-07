// One-off spike: which Bedrock client + model-ID form works in this account,
// and do structured outputs survive? Run: bun run scripts/bedrock-spike.ts
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk/mantle-client";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

// direct egress for the spike
for (const v of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"])
  delete process.env[v];

const Schema = z.object({ answer: z.string(), confidence: z.enum(["low", "high"]) });
const REGION = process.env.AWS_REGION ?? "us-west-2";

async function tryCase(label: string, fn: () => Promise<unknown>) {
  const started = Date.now();
  try {
    const out = await fn();
    console.log(`✅ ${label} (${Date.now() - started}ms):`, JSON.stringify(out).slice(0, 120));
    return true;
  } catch (e: any) {
    console.log(`❌ ${label} (${Date.now() - started}ms): [${e?.status ?? "?"}] ${String(e?.message ?? e).slice(0, 300)}`);
    return false;
  }
}

const mantle = new AnthropicBedrockMantle({ awsRegion: REGION, timeout: 60_000, maxRetries: 0 });
const classic = new AnthropicBedrock({ awsRegion: REGION, timeout: 60_000, maxRetries: 0 });

const structured = (client: AnthropicBedrock | AnthropicBedrockMantle, model: string) => () =>
  client.messages
    .parse({
      model,
      max_tokens: 200,
      messages: [{ role: "user", content: "Is water wet? Answer via the schema." }],
      output_config: { format: zodOutputFormat(Schema) },
    })
    .then(r => r.parsed_output);

const plain = (client: AnthropicBedrock | AnthropicBedrockMantle, model: string) => () =>
  client.messages
    .create({ model, max_tokens: 50, messages: [{ role: "user", content: "Say OK." }] })
    .then(r => r.content.filter(b => b.type === "text").map(b => b.text).join(""));

console.log(`region: ${REGION}\n`);
console.log("— Mantle client, bare first-party ID —");
await tryCase("mantle + claude-sonnet-4-6 + plain", plain(mantle, "claude-sonnet-4-6"));
await tryCase("mantle + claude-sonnet-4-6 + structured", structured(mantle, "claude-sonnet-4-6"));

console.log("\n— Classic client, us. profile without -v1 —");
await tryCase("classic + us.anthropic.claude-sonnet-4-6 + plain", plain(classic, "us.anthropic.claude-sonnet-4-6"));
await tryCase("classic + us.anthropic.claude-sonnet-4-6 + structured", structured(classic, "us.anthropic.claude-sonnet-4-6"));
