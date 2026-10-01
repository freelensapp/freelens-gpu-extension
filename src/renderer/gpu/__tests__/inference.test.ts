import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyInference, inferenceStatus, parseVllm, type VllmSample, vllmRates } from "../inference";
import { parsePrometheusText } from "../prom";

const idleText = readFileSync(join(__dirname, "fixtures", "vllm_v1_idle.prom"), "utf8");
const idle = parseVllm(parsePrometheusText(idleText));

describe("vLLM metrics", () => {
  it("classifies by content", () => {
    expect(classifyInference(idleText)).toBe("vllm");
    expect(classifyInference('http_requests_total{path="/"} 3')).toBeUndefined();
  });

  it("parses the real V1 capture", () => {
    expect(idle).toMatchObject({
      models: ["gemma-4-E4B-it"],
      running: 0,
      waiting: 0,
      waitingCapacity: 0,
      kvCachePct: 0,
      preemptions: 0,
      errors: 0,
      aborts: 0,
      asleep: false,
      gpuMemoryUtilization: 0.9,
    });
    expect(idle.ttftCount).toBe(16700);
    expect(idle.prefixHits! / idle.prefixQueries!).toBeCloseTo(0.524, 2); // 2,905,888 / 5,542,562
  });

  it("reads the pre-V1 KV cache name and sums data-parallel engines", () => {
    const s = parseVllm(
      parsePrometheusText(
        [
          'vllm:gpu_cache_usage_perc{model_name="/m/llama-3-8b",engine="0"} 0.4',
          'vllm:gpu_cache_usage_perc{model_name="/m/llama-3-8b",engine="1"} 0.95',
          'vllm:num_requests_running{model_name="/m/llama-3-8b",engine="0"} 3',
          'vllm:num_requests_running{model_name="/m/llama-3-8b",engine="1"} 5',
        ].join("\n"),
      ),
    );
    expect(s).toMatchObject({ models: ["llama-3-8b"], running: 8, kvCachePct: 95 });
  });
});

describe("rates and status", () => {
  const busy: VllmSample = {
    ...idle,
    running: 12,
    waiting: 4,
    kvCachePct: 96,
    generationTokens: idle.generationTokens + 20_000,
    promptTokens: idle.promptTokens + 60_000,
    ttftSum: idle.ttftSum + 30,
    ttftCount: idle.ttftCount + 100,
    preemptions: 7,
    errors: 1,
  };

  it("computes throughput, recent TTFT and new preemptions between scrapes", () => {
    expect(vllmRates(idle, busy, 20)).toEqual({
      generationTokPerSec: 1000,
      promptTokPerSec: 3000,
      ttftMs: 300,
      newPreemptions: 7,
      newErrors: 1,
    });
  });

  it("gives no rates on the first sample or after a restart (counters went down)", () => {
    expect(vllmRates(undefined, idle, 20)).toEqual({});
    const r = vllmRates(busy, idle, 20);
    expect(r.generationTokPerSec).toBeUndefined();
    expect(r.newPreemptions).toBeUndefined();
  });

  it("flags saturation, then pressure, and calls an idle server idle", () => {
    expect(inferenceStatus(busy, vllmRates(idle, busy, 20))).toEqual({
      level: "bad",
      text: "saturated: KV cache 96%, 4 waiting, 7 preempted (KV cache pressure), 1 failed/aborted",
    });
    expect(inferenceStatus({ ...idle, kvCachePct: 92, running: 3 }, {}).level).toBe("warn");
    expect(inferenceStatus({ ...idle, running: 3 }, {})).toEqual({ level: "ok", text: "serving 3" });
    expect(inferenceStatus(idle, {})).toEqual({ level: "idle", text: "idle" });
    expect(inferenceStatus({ ...idle, asleep: true }, {})).toEqual({
      level: "idle",
      text: "asleep (weights offloaded)",
    });
  });
});
