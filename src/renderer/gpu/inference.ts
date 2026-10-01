/**
 * LLM inference servers next to the GPUs they run on. vLLM exposes Prometheus
 * metrics on its API port; GPU utilisation alone says little about a serving
 * engine (it pre-allocates ~90% of VRAM and can sit at low SM use while its
 * queue grows), so the serving-side numbers are what tell you it is healthy.
 *
 * Pure functions: parse one /metrics body, and turn two consecutive samples
 * into rates.
 */

import type { Families } from "./prom";

export type InferenceEngine = "vllm";

/** Pods worth probing for inference metrics besides GPU-requesting ones. */
export const INFERENCE_HINT = /vllm|sglang|tritonserver|text-generation-inference|kserve|predictor/i;

export function classifyInference(text: string): InferenceEngine | undefined {
  return text.includes("vllm:") ? "vllm" : undefined;
}

/** One vLLM scrape, summed over engines (data-parallel) and models served by the pod. */
export interface VllmSample {
  models: string[];
  running: number;
  waiting: number;
  /** Waiting for scheduling capacity (as opposed to deferred by LoRA budget / KV transfer). */
  waitingCapacity?: number;
  /** KV cache in use, 0-100; the fullest engine. */
  kvCachePct?: number;
  preemptions: number;
  promptTokens: number;
  generationTokens: number;
  ttftSum: number;
  ttftCount: number;
  prefixHits?: number;
  prefixQueries?: number;
  /** Requests that finished with finished_reason="error" / "abort". */
  errors: number;
  aborts: number;
  /** Engine is in a sleep state (weights offloaded) rather than awake. */
  asleep: boolean;
  /** --gpu-memory-utilization: the VRAM share vLLM reserves up front. */
  gpuMemoryUtilization?: number;
}

const sum = (f: Families, name: string, where?: (l: Record<string, string>) => boolean) => {
  let total = 0;
  let seen = false;
  for (const s of f.get(name) ?? []) {
    if (where && !where(s.labels)) continue;
    if (Number.isFinite(s.value)) {
      total += s.value;
      seen = true;
    }
  }
  return seen ? total : undefined;
};

const max = (f: Families, name: string) => {
  const vals = (f.get(name) ?? []).map((s) => s.value).filter(Number.isFinite);
  return vals.length > 0 ? Math.max(...vals) : undefined;
};

export function parseVllm(f: Families): VllmSample {
  const models = new Set<string>();
  for (const samples of f.values()) {
    for (const s of samples) {
      if (s.name.startsWith("vllm:") && s.labels.model_name) models.add(s.labels.model_name.split("/").pop() || "");
    }
  }
  // vLLM V1 renamed gpu_cache_usage_perc to kv_cache_usage_perc; both are ratios [0,1].
  const kv = max(f, "vllm:kv_cache_usage_perc") ?? max(f, "vllm:gpu_cache_usage_perc");
  const awake = sum(f, "vllm:engine_sleep_state", (l) => l.sleep_state === "awake");
  const cfg = (f.get("vllm:cache_config_info") ?? [])[0]?.labels.gpu_memory_utilization;
  return {
    models: [...models].filter(Boolean).sort(),
    running: sum(f, "vllm:num_requests_running") ?? 0,
    waiting: sum(f, "vllm:num_requests_waiting") ?? 0,
    waitingCapacity: sum(f, "vllm:num_requests_waiting_by_reason", (l) => l.reason === "capacity"),
    kvCachePct: kv === undefined ? undefined : kv * 100,
    preemptions: sum(f, "vllm:num_preemptions_total") ?? 0,
    promptTokens: sum(f, "vllm:prompt_tokens_total") ?? 0,
    generationTokens: sum(f, "vllm:generation_tokens_total") ?? 0,
    ttftSum: sum(f, "vllm:time_to_first_token_seconds_sum") ?? 0,
    ttftCount: sum(f, "vllm:time_to_first_token_seconds_count") ?? 0,
    prefixHits: sum(f, "vllm:prefix_cache_hits_total"),
    prefixQueries: sum(f, "vllm:prefix_cache_queries_total"),
    errors: sum(f, "vllm:request_success_total", (l) => l.finished_reason === "error") ?? 0,
    aborts: sum(f, "vllm:request_success_total", (l) => l.finished_reason === "abort") ?? 0,
    asleep: awake !== undefined && awake === 0,
    gpuMemoryUtilization: cfg !== undefined && Number.isFinite(Number(cfg)) ? Number(cfg) : undefined,
  };
}

export interface VllmRates {
  generationTokPerSec?: number;
  promptTokPerSec?: number;
  /** Mean time to first token over the interval, ms (undefined when no request started). */
  ttftMs?: number;
  newPreemptions?: number;
  newErrors?: number;
}

/**
 * Rates between two samples of the same pod. Counter resets (pod restarted: a counter went down) yield undefined
 * rather than negative numbers.
 */
export function vllmRates(prev: VllmSample | undefined, cur: VllmSample, dtSec: number): VllmRates {
  if (!prev || dtSec <= 0) return {};
  const d = (a: number, b: number) => (b >= a ? b - a : undefined);
  const gen = d(prev.generationTokens, cur.generationTokens);
  const prompt = d(prev.promptTokens, cur.promptTokens);
  const tSum = d(prev.ttftSum, cur.ttftSum);
  const tCount = d(prev.ttftCount, cur.ttftCount);
  return {
    generationTokPerSec: gen === undefined ? undefined : gen / dtSec,
    promptTokPerSec: prompt === undefined ? undefined : prompt / dtSec,
    ttftMs: tSum !== undefined && tCount ? (tSum / tCount) * 1000 : undefined,
    newPreemptions: d(prev.preemptions, cur.preemptions),
    newErrors: d(prev.errors + prev.aborts, cur.errors + cur.aborts),
  };
}

export type InferenceLevel = "ok" | "warn" | "bad" | "idle";

/** What a person should notice about a server right now. */
export function inferenceStatus(s: VllmSample, r: VllmRates): { level: InferenceLevel; text: string } {
  const issues: string[] = [];
  let level: InferenceLevel = "ok";
  const kv = s.kvCachePct ?? 0;
  if (s.waiting > 0 && kv >= 90) {
    issues.push(`saturated: KV cache ${kv.toFixed(0)}%, ${s.waiting} waiting`);
    level = "bad";
  } else if (kv >= 90) {
    issues.push(`KV cache ${kv.toFixed(0)}%`);
    level = "warn";
  } else if (s.waiting > 0) {
    issues.push(`${s.waiting} waiting`);
    level = "warn";
  }
  if ((r.newPreemptions ?? 0) > 0) {
    issues.push(`${r.newPreemptions} preempted (KV cache pressure)`);
    if (level === "ok") level = "warn";
  }
  if ((r.newErrors ?? 0) > 0) {
    issues.push(`${r.newErrors} failed/aborted`);
    if (level === "ok") level = "warn";
  }
  if (issues.length > 0) return { level, text: issues.join(", ") };
  if (s.asleep) return { level: "idle", text: "asleep (weights offloaded)" };
  if (s.running === 0) return { level: "idle", text: "idle" };
  return { level: "ok", text: `serving ${s.running}` };
}
