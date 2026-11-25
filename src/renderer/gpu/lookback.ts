/**
 * Lookback: what each pod did with its GPUs over the last day or week, read from a Prometheus-compatible query API
 * that already keeps the exporter's series. The session history of the store starts when Freelens opens; this
 * answers "idle since when" and "how much VRAM did it ever need" for the time before that.
 *
 * One range query per metric, `max_over_time(<metric>[<step>])` at that step: every point is the maximum of its own
 * step, so a short burst between two points is not missed and the peaks are exact. Everything below is pure; the
 * scraper does the requests.
 */

import { type PromTarget, promApiPath, repairLabels } from "./prometheus";

import type { HistoryPoint } from "./types";

export type LookbackWindow = "24h" | "7d";

/** About 300 points per series in both windows. */
export const LOOKBACK_WINDOWS: Record<LookbackWindow, { windowS: number; stepS: number; label: string }> = {
  "24h": { windowS: 24 * 3600, stepS: 300, label: "24 h" },
  "7d": { windowS: 7 * 24 * 3600, stepS: 1800, label: "7 d" },
};

/** The series the lookback reads: utilisation and VRAM, from dcgm-exporter and from a per-process exporter. */
export const LOOKBACK_METRICS = [
  "DCGM_FI_DEV_GPU_UTIL",
  "DCGM_FI_PROF_GR_ENGINE_ACTIVE",
  "DCGM_FI_DEV_FB_USED",
  "gpu_process_utilization_percent",
  "gpu_process_memory_bytes",
] as const;

export type LookbackMetric = (typeof LOOKBACK_METRICS)[number];

export const lookbackQuery = (metric: LookbackMetric, stepS: number): string => `max_over_time(${metric}[${stepS}s])`;

/** Start and end of the range in seconds, aligned to the step so that consecutive refreshes read the same steps. */
export function lookbackRange(nowMs: number, window: LookbackWindow): { startS: number; endS: number; stepS: number } {
  const { windowS, stepS } = LOOKBACK_WINDOWS[window];
  const endS = Math.floor(nowMs / 1000 / stepS) * stepS;
  return { startS: endS - windowS + stepS, endS, stepS };
}

export function promRangePath(t: PromTarget, query: string, startS: number, endS: number, stepS: number): string {
  return promApiPath(t, "query_range", { query, start: startS, end: endS, step: stepS });
}

export interface PodLookback {
  /** Start of the first step in which the pod had a sample, in ms. */
  firstSeen: number;
  /** Highest VRAM the pod held in one step, in MiB: its devices summed, each at its maximum of that step. */
  peakVramMiB: number;
  /** Highest utilisation of any of its devices; undefined when no utilisation series exists for the pod. */
  peakUtilPct?: number;
  /** Share of the steps with a utilisation sample in which the pod stayed under the idle threshold, 0 to 1. */
  idleShare?: number;
  /** Time covered by the steps with a utilisation sample, in ms. */
  observedMs: number;
  /** Start of the first step with a utilisation sample, in ms. */
  utilFrom?: number;
  /**
   * End of the last step in which the pod was busy, in ms; undefined when it never was (or has no utilisation
   * series). The pod was last busy somewhere inside that step, so it has been idle since then at the latest.
   */
  lastBusy?: number;
}

interface PromMatrix {
  status?: string;
  error?: string;
  data?: { result?: { metric: Record<string, string>; values?: [number, string][] }[] };
}

interface PodSteps {
  /** Per step (seconds): utilisation in %, the maximum over the pod's devices. */
  util: Map<number, number>;
  /** Per step (seconds): VRAM in MiB, summed over the pod's devices. */
  vram: Map<number, number>;
}

interface Source {
  dcgmUtil: Map<string, PodSteps>;
  dcgmProf: Map<string, PodSteps>;
  dcgm: Map<string, PodSteps>;
  process: Map<string, PodSteps>;
}

function stepsOf(m: Map<string, PodSteps>, pod: string): PodSteps {
  let s = m.get(pod);
  if (!s) {
    s = { util: new Map(), vram: new Map() };
    m.set(pod, s);
  }
  return s;
}

/**
 * Range-query results, one per metric, into what each pod ("namespace/pod") did over the range.
 *
 * Same rules as the live view: the labels Prometheus rewrote are repaired and the copies of a series are merged;
 * a pod the per-process exporter reports is taken from it, since it splits a shared device per pod and dcgm-exporter
 * does not; DCGM_FI_DEV_GPU_UTIL wins over the profiling counter, which stands in for it on MIG slices.
 */
export function podLookbacks(
  results: { metric: LookbackMetric; json: string }[],
  stepS: number,
  idleUtilPct: number,
): Map<string, PodLookback> {
  const src: Source = { dcgmUtil: new Map(), dcgmProf: new Map(), dcgm: new Map(), process: new Map() };
  for (const { metric, json } of results) {
    let parsed: PromMatrix;
    try {
      parsed = JSON.parse(json) as PromMatrix;
    } catch {
      throw new Error(`not a Prometheus API response (${json.slice(0, 80)})`);
    }
    if (parsed.status !== "success") throw new Error(parsed.error ?? "query failed");
    // The copies of one series differ only in labels repairLabels drops: an HA pair, or the two halves of a series
    // whose exporter pod was replaced inside the window (a new instance). Merge them, each step once at its maximum.
    const merged = new Map<string, { pod: string; values: Map<number, number> }>();
    for (const r of parsed.data?.result ?? []) {
      const { labels } = repairLabels(r.metric);
      if (!labels.pod) continue;
      const key = Object.keys(labels)
        .sort()
        .map((k) => `${k}=${labels[k]}`)
        .join(",");
      let entry = merged.get(key);
      if (!entry) {
        entry = { pod: `${labels.namespace ?? ""}/${labels.pod}`, values: new Map() };
        merged.set(key, entry);
      }
      for (const [t, raw] of r.values ?? []) {
        const v = Number(raw);
        if (!Number.isFinite(v)) continue;
        entry.values.set(t, Math.max(entry.values.get(t) ?? v, v));
      }
    }
    for (const { pod, values } of merged.values()) {
      for (const [t, v] of values) {
        switch (metric) {
          case "DCGM_FI_DEV_GPU_UTIL": {
            const s = stepsOf(src.dcgmUtil, pod).util;
            s.set(t, Math.max(s.get(t) ?? 0, v));
            break;
          }
          case "DCGM_FI_PROF_GR_ENGINE_ACTIVE": {
            const s = stepsOf(src.dcgmProf, pod).util;
            s.set(t, Math.max(s.get(t) ?? 0, v * 100)); // ratio -> percent
            break;
          }
          case "DCGM_FI_DEV_FB_USED": {
            const s = stepsOf(src.dcgm, pod).vram;
            s.set(t, (s.get(t) ?? 0) + v);
            break;
          }
          case "gpu_process_utilization_percent": {
            const s = stepsOf(src.process, pod).util;
            s.set(t, Math.max(s.get(t) ?? 0, v));
            break;
          }
          case "gpu_process_memory_bytes": {
            const s = stepsOf(src.process, pod).vram;
            s.set(t, (s.get(t) ?? 0) + v / (1024 * 1024));
            break;
          }
        }
      }
    }
  }

  const out = new Map<string, PodLookback>();
  const pods = new Set([...src.process.keys(), ...src.dcgm.keys(), ...src.dcgmUtil.keys(), ...src.dcgmProf.keys()]);
  for (const pod of pods) {
    const proc = src.process.get(pod);
    const vram = proc ? proc.vram : (src.dcgm.get(pod)?.vram ?? new Map<number, number>());
    const util = proc
      ? proc.util
      : (src.dcgmUtil.get(pod)?.util ?? src.dcgmProf.get(pod)?.util ?? new Map<number, number>());
    const times = [...vram.keys(), ...util.keys()];
    if (times.length === 0) continue;
    const stepMs = stepS * 1000;
    // A point at t is the maximum over (t - step, t].
    const firstSeen = Math.min(...times) * 1000 - stepMs;
    const lb: PodLookback = {
      firstSeen,
      peakVramMiB: Math.max(0, ...vram.values()),
      observedMs: util.size * stepMs,
    };
    if (util.size > 0) {
      const utilTimes = [...util.keys()].sort((a, b) => a - b);
      let idleSteps = 0;
      let lastBusy: number | undefined;
      for (const t of utilTimes) {
        if ((util.get(t) ?? 0) < idleUtilPct) idleSteps++;
        else lastBusy = t;
      }
      lb.peakUtilPct = Math.max(...util.values());
      lb.idleShare = idleSteps / util.size;
      lb.utilFrom = utilTimes[0] * 1000 - stepMs;
      if (lastBusy !== undefined) lb.lastBusy = lastBusy * 1000;
    }
    out.set(pod, lb);
  }
  return out;
}

export interface IdleStretch {
  /** Start of the current idle stretch, in ms. */
  since: number;
  /** Samples of the session behind it (0 when it rests on the lookback alone). */
  samples: number;
  /** The pod may have been idle for longer: nothing older is known, and no busy moment was seen. */
  atLeast: boolean;
  /** Where `since` comes from. */
  from: "session" | "lookback";
}

/**
 * How long a pod that is idle now has been idle.
 *
 * The session history is sampled every scrape and is the newest evidence: a busy sample in it ends the question.
 * When the whole session is idle, the lookback says how far back the stretch reaches: to its last busy step, or,
 * for a pod it never saw busy, to the first sample it has (the pod may have been idle for longer than that).
 */
export function idleStretch(
  history: HistoryPoint[],
  lookback: PodLookback | undefined,
  nowMs: number,
  idleUtilPct: number,
): IdleStretch {
  let i = history.length - 1;
  while (i >= 0 && history[i].utilPct < idleUtilPct) i--;
  const samples = history.length - 1 - i;
  const sessionSince = history[i + 1]?.t ?? nowMs;
  if (i >= 0) return { since: sessionSince, samples, atLeast: false, from: "session" };
  if (lookback?.lastBusy !== undefined) {
    return { since: Math.min(lookback.lastBusy, nowMs), samples, atLeast: false, from: "lookback" };
  }
  if (lookback?.utilFrom !== undefined && lookback.utilFrom < sessionSince) {
    return { since: lookback.utilFrom, samples, atLeast: true, from: "lookback" };
  }
  return { since: sessionSince, samples, atLeast: true, from: "session" };
}
