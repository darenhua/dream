import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { db } from "../db";
import { agentRun } from "../db/schema";
import { env } from "../lib/env";
import { getConfig } from "./config";
import { emit } from "./events";

// Amendment 9: plain SDK + native structured outputs (schema enforced server-side),
// zod re-validation client-side, one retry on invalid output.

const MODEL_ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-8",
  haiku: "claude-haiku-4-5",
};

export function resolveModel(): string {
  const configured = getConfig<string>("MODEL");
  return MODEL_ALIASES[configured] ?? configured;
}

const client = new Anthropic({
  apiKey: env.ANTHROPIC_API_KEY,
  timeout: 120_000, // user's network can be flaky — fail into agent_run.error, don't hang
  maxRetries: 2,
});

type AgentName = "categorizer" | "deriver" | "daily_writeup";

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

// Structured-output run (categorizer, deriver).
export async function runStructured<S extends z.ZodType>(
  agentName: AgentName,
  workspacePath: string,
  schema: S,
  opts: { trigger: "daily" | "manual"; hints?: string },
): Promise<RunResult<z.infer<S>>> {
  const prompt = buildPrompt(agentName, workspacePath, opts.hints);
  const started = Date.now();
  let lastError = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await client.messages.parse({
        model: resolveModel(),
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

// Plain-text run (daily writeup).
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
