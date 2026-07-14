import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { db } from "../db";
import { agentRun } from "../db/schema";
import { env } from "../lib/env";
import { getConfig } from "./config";
import { emit } from "./events";

// Amendments 9 + 10: plain SDK + native structured outputs (schema enforced
// server-side), zod re-validation client-side, one retry on invalid output.
// Provider is env-switched: USE_BEDROCK=true → AWS Bedrock (classic
// bedrock-runtime; Sonnet 4.6 is not on the Mantle surface), else the
// first-party API with ANTHROPIC_API_KEY.

const MODEL_ALIASES_API: Record<string, string> = {
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-8",
  haiku: "claude-haiku-4-5",
};

// Bedrock on-demand needs cross-region inference-profile IDs (bare "anthropic."
// IDs 400). Suffix forms differ per model generation — verified live 2026-07-08
// (us-west-2): 4.6+/4.8 have no suffix, pre-4.6 keep the dated "-v1:0".
// Swap "us." for "global." to use global routing (no CRIS premium).
const MODEL_ALIASES_BEDROCK: Record<string, string> = {
  sonnet: "us.anthropic.claude-sonnet-4-6",
  opus: "us.anthropic.claude-opus-4-8",
  haiku: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
};

export function resolveModel(alias?: string): string {
  const configured = alias ?? getConfig<string>("MODEL");
  const aliases = env.USE_BEDROCK ? MODEL_ALIASES_BEDROCK : MODEL_ALIASES_API;
  return aliases[configured] ?? configured; // raw IDs pass through untouched
}

// AnthropicBedrock resolves credentials via the standard AWS chain (env vars,
// ~/.aws/credentials, SSO). It does NOT read the region from ~/.aws/config —
// pass it explicitly or requests silently target us-east-1.
const client: Anthropic | AnthropicBedrock = env.USE_BEDROCK
  ? new AnthropicBedrock({
      awsRegion: env.AWS_REGION,
      timeout: 120_000, // user's network can be flaky — fail into agent_run.error, don't hang
      maxRetries: 2,
    })
  : new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      timeout: 120_000,
      maxRetries: 2,
    });

type AgentName =
  | "distiller"
  | "deriver"
  | "proposal_reviser"
  | "schedule_agent"
  | "prompt_generator"
  | "daily_writeup"
  | "rant_detector"
  | "review_writeup"
  | "witness_composer"
  | "witness_prompter";

// Agents get read-only file context only (§8.5): the projected workspace is
// inlined into the prompt; the files stay on disk as the audit trail (A4).
function readWorkspace(dir: string, prefix = ""): { name: string; content: string }[] {
  const out: { name: string; content: string }[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...readWorkspace(full, `${prefix}${entry}/`));
    else out.push({ name: `${prefix}${entry}`, content: readFileSync(full, "utf-8") });
  }
  return out;
}

function buildPrompt(agentName: AgentName, workspacePath: string, hints?: string): string {
  const preamble = getConfig<string>("PROMPT.preamble");
  const prompt = getConfig<string>(`PROMPT.${agentName}`);
  const files = readWorkspace(workspacePath)
    .map(f => `<file name="${f.name}">\n${f.content}\n</file>`)
    .join("\n\n");
  return `${preamble}\n\n${prompt}\n\n${hints ? `${hints}\n\n` : ""}# Context files\n\n${files}`;
}

export interface RunResult<T> {
  runId: string;
  status: "ok" | "invalid_output" | "failed";
  output: T | null;
  error?: string;
}

function persistRun(fields: typeof agentRun.$inferInsert): string {
  const row = db.insert(agentRun).values(fields).returning({ id: agentRun.id }).get();
  emit("agent_run", row.id, "agent_run_completed", {
    agentName: fields.agentName,
    status: fields.status,
  });
  return row.id;
}

// Structured-output run (distiller, deriver).
export async function runStructured<S extends z.ZodType>(
  agentName: AgentName,
  workspacePath: string,
  schema: S,
  opts: { trigger: "daily" | "manual"; hints?: string; model?: string },
): Promise<RunResult<z.infer<S>>> {
  const prompt = buildPrompt(agentName, workspacePath, opts.hints);
  const started = Date.now();
  let lastError = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await client.messages.parse({
        model: resolveModel(opts.model),
        max_tokens: 8192,
        messages: [{ role: "user", content: prompt }],
        output_config: { format: zodOutputFormat(schema) },
      });
      const parsed = response.parsed_output;
      if (parsed == null) {
        lastError = `no parsed output (stop_reason: ${response.stop_reason})`;
        continue;
      }
      const runId = persistRun({
        agentName,
        trigger: opts.trigger,
        workspacePath,
        outputJson: JSON.stringify(parsed),
        status: "ok",
        tokenUsage: JSON.stringify({
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
        }),
        durationMs: Date.now() - started,
      });
      return { runId, status: "ok", output: parsed };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      // Big schemas (the deriver's 9-way proposal union) can exceed the
      // server-side grammar compiler's limit. Amendment 9's sanctioned
      // fallback: plain call with the JSON schema in the prompt, zod
      // validation client-side — same guarantee for us, no schema surgery.
      if (lastError.includes("grammar is too large")) {
        return runStructuredUnconstrained(agentName, prompt, workspacePath, schema, opts, started);
      }
    }
  }

  const status = lastError.includes("parsed") || lastError.includes("schema") ? "invalid_output" : "failed";
  const runId = persistRun({
    agentName,
    trigger: opts.trigger,
    workspacePath,
    status: status as "invalid_output" | "failed",
    durationMs: Date.now() - started,
    error: lastError,
  });
  return { runId, status: status as "invalid_output" | "failed", output: null, error: lastError };
}

// The grammar-limit fallback: no output_config — the schema travels in the
// prompt and zod is the only validator (which it effectively is anyway).
// Second attempt feeds the first attempt's validation error back.
async function runStructuredUnconstrained<S extends z.ZodType>(
  agentName: AgentName,
  prompt: string,
  workspacePath: string,
  schema: S,
  opts: { trigger: "daily" | "manual"; model?: string },
  started: number,
): Promise<RunResult<z.infer<S>>> {
  const jsonSchema = JSON.stringify(z.toJSONSchema(schema));
  let feedback = "";
  let lastError = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await client.messages.create({
        model: resolveModel(opts.model),
        max_tokens: 8192,
        messages: [
          {
            role: "user",
            content:
              `${prompt}\n\n# Output format\n\nRespond with ONLY a JSON object valid against this JSON Schema — no prose, no code fences:\n${jsonSchema}${feedback}`,
          },
        ],
      });
      const text = response.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("")
        .trim()
        .replace(/^```(?:json)?\n?/, "")
        .replace(/\n?```$/, "");
      const parsed = schema.parse(JSON.parse(text));
      const runId = persistRun({
        agentName,
        trigger: opts.trigger,
        workspacePath,
        outputJson: JSON.stringify(parsed),
        status: "ok",
        tokenUsage: JSON.stringify({
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
        }),
        durationMs: Date.now() - started,
      });
      return { runId, status: "ok", output: parsed };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      feedback = `\n\nYour previous attempt failed validation with: ${lastError.slice(0, 600)}. Fix it and respond with only the corrected JSON.`;
    }
  }

  const runId = persistRun({
    agentName,
    trigger: opts.trigger,
    workspacePath,
    status: "invalid_output",
    durationMs: Date.now() - started,
    error: `unconstrained fallback failed: ${lastError}`,
  });
  return { runId, status: "invalid_output", output: null, error: lastError };
}

// Multi-turn structured chat (schedule agent): full history in, one validated
// turn out. The agent re-emits the complete plan each turn, so no tool loop is
// needed and the call shape is identical on Bedrock.
export async function runChatTurn<S extends z.ZodType>(
  agentName: AgentName,
  system: string,
  history: { role: "user" | "assistant"; content: string }[],
  schema: S,
  opts: { trigger: "daily" | "manual" },
): Promise<RunResult<z.infer<S>>> {
  const preamble = getConfig<string>("PROMPT.preamble");
  const prompt = getConfig<string>(`PROMPT.${agentName}`);
  const started = Date.now();
  let lastError = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await client.messages.parse({
        model: resolveModel(),
        max_tokens: 8192,
        system: `${preamble}\n\n${prompt}\n\n${system}`,
        messages: history,
        output_config: { format: zodOutputFormat(schema) },
      });
      const parsed = response.parsed_output;
      if (parsed == null) {
        lastError = `no parsed output (stop_reason: ${response.stop_reason})`;
        continue;
      }
      const runId = persistRun({
        agentName,
        trigger: opts.trigger,
        outputJson: JSON.stringify(parsed),
        status: "ok",
        tokenUsage: JSON.stringify({
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
        }),
        durationMs: Date.now() - started,
      });
      return { runId, status: "ok", output: parsed };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  const status = lastError.includes("parsed") || lastError.includes("schema") ? "invalid_output" : "failed";
  const runId = persistRun({
    agentName,
    trigger: opts.trigger,
    status: status as "invalid_output" | "failed",
    durationMs: Date.now() - started,
    error: lastError,
  });
  return { runId, status: status as "invalid_output" | "failed", output: null, error: lastError };
}

// Plain-text run (daily writeup, prompt generator).
export async function runText(
  agentName: AgentName,
  workspacePath: string,
  opts: { trigger: "daily" | "manual"; hints?: string },
): Promise<RunResult<string>> {
  const prompt = buildPrompt(agentName, workspacePath, opts.hints);
  const started = Date.now();
  try {
    const response = await client.messages.create({
      model: resolveModel(),
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("")
      .trim();
    const runId = persistRun({
      agentName,
      trigger: opts.trigger,
      workspacePath,
      outputJson: JSON.stringify(text),
      status: "ok",
      tokenUsage: JSON.stringify({
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      }),
      durationMs: Date.now() - started,
    });
    return { runId, status: "ok", output: text };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const runId = persistRun({
      agentName,
      trigger: opts.trigger,
      workspacePath,
      status: "failed",
      durationMs: Date.now() - started,
      error,
    });
    return { runId, status: "failed", output: null, error };
  }
}
