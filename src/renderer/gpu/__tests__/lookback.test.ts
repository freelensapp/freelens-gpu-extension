import { describe, expect, it } from "vitest";
import {
  idleStretch,
  LOOKBACK_METRICS,
  type LookbackMetric,
  lookbackQuery,
  lookbackRange,
  podLookbacks,
  promRangePath,
} from "../lookback";

const STEP = 1800;
const T0 = 1_800_000_000; // a multiple of the step
const at = (i: number) => T0 + i * STEP;

type Series = { metric: Record<string, string>; values: [number, string][] };
const matrix = (...result: Series[]) => JSON.stringify({ status: "success", data: { resultType: "matrix", result } });
const series = (labels: Record<string, string>, values: number[], from = 0): Series => ({
  metric: labels,
  values: values.map((v, i) => [at(from + i), String(v)]),
});
const run = (by: Partial<Record<LookbackMetric, string>>) =>
  podLookbacks(
    LOOKBACK_METRICS.map((metric) => ({ metric, json: by[metric] ?? matrix() })),
    STEP,
    5,
  );

describe("lookback range", () => {
  it("aligns the range to the step and asks for one point per step of the window", () => {
    const now = (at(10) + 17 * 60) * 1000; // 17 minutes into a step
    expect(lookbackRange(now, "7d")).toEqual({ startS: at(10) - 7 * 86400 + STEP, endS: at(10), stepS: STEP });
    const day = lookbackRange(now, "24h");
    expect(day.stepS).toBe(300);
    expect((day.endS - day.startS) / day.stepS + 1).toBe(288);
    expect(day.endS % 300).toBe(0);
  });

  it("queries the maximum of each step through the service proxy", () => {
    expect(lookbackQuery("DCGM_FI_DEV_FB_USED", STEP)).toBe("max_over_time(DCGM_FI_DEV_FB_USED[1800s])");
    expect(
      promRangePath({ namespace: "mon", name: "prometheus-server", port: 80 }, "max_over_time(x[60s])", 1, 2, 60),
    ).toBe(
      "/api/v1/namespaces/mon/services/prometheus-server:80/proxy/api/v1/query_range?query=max_over_time(x%5B60s%5D)&start=1&end=2&step=60",
    );
  });
});

describe("podLookbacks", () => {
  it("finds the last busy step, the idle share and the peaks of a pod", () => {
    const labels = { gpu: "0", UUID: "GPU-a", namespace: "ml", pod: "trainer-0", Hostname: "n1" };
    const out = run({
      DCGM_FI_DEV_GPU_UTIL: matrix(series(labels, [0, 80, 97, 3, 0, 0, 0, 1])),
      DCGM_FI_DEV_FB_USED: matrix(series(labels, [500, 30000, 41000, 41000, 41000, 41000, 41000, 41000])),
    });
    expect(out.get("ml/trainer-0")).toEqual({
      firstSeen: (T0 - STEP) * 1000,
      utilFrom: (T0 - STEP) * 1000,
      peakVramMiB: 41000,
      peakUtilPct: 97,
      idleShare: 6 / 8,
      observedMs: 8 * STEP * 1000,
      lastBusy: at(2) * 1000,
    });
  });

  it("leaves lastBusy out for a pod that was never busy", () => {
    const labels = { gpu: "1", UUID: "GPU-b", namespace: "ml", pod: "notebook-0" };
    const lb = run({
      DCGM_FI_DEV_GPU_UTIL: matrix(series(labels, [0, 0, 2, 0], 4)),
      DCGM_FI_DEV_FB_USED: matrix(series(labels, [9000, 9000, 9000, 9000], 4)),
    }).get("ml/notebook-0");
    expect(lb?.lastBusy).toBeUndefined();
    expect(lb?.idleShare).toBe(1);
    expect(lb?.utilFrom).toBe(at(3) * 1000);
  });

  it("repairs relabelled series and counts an HA pair once", () => {
    const relabelled = (replica: string) => ({
      gpu: "0",
      UUID: "GPU-a",
      exported_namespace: "ml",
      exported_pod: "vllm-0",
      namespace: "gpu-operator",
      pod: "nvidia-dcgm-exporter-x",
      job: "nvidia-dcgm-exporter",
      instance: "10.0.0.7:9400",
      prometheus_replica: replica,
    });
    const out = run({
      DCGM_FI_DEV_FB_USED: matrix(
        series(relabelled("prometheus-0"), [4096]),
        series(relabelled("prometheus-1"), [4096]),
      ),
    });
    expect([...out.keys()]).toEqual(["ml/vllm-0"]);
    expect(out.get("ml/vllm-0")?.peakVramMiB).toBe(4096);
  });

  it("drops device series that no pod holds", () => {
    const out = run({
      DCGM_FI_DEV_FB_USED: matrix(
        series({ gpu: "3", UUID: "GPU-d", namespace: "gpu-operator", pod: "nvidia-dcgm-exporter-x" }, [0, 0]),
      ),
    });
    expect(out.size).toBe(0);
  });

  it("sums the VRAM of a pod's devices per step and takes the busiest device for utilisation", () => {
    const a = { gpu: "0", UUID: "GPU-a", namespace: "ml", pod: "ddp-0" };
    const b = { gpu: "1", UUID: "GPU-b", namespace: "ml", pod: "ddp-0" };
    const lb = run({
      DCGM_FI_DEV_GPU_UTIL: matrix(series(a, [10, 0]), series(b, [60, 0])),
      DCGM_FI_DEV_FB_USED: matrix(series(a, [1000, 3000]), series(b, [2000, 500])),
    }).get("ml/ddp-0");
    // the peak is the highest sum of one step, not the sum of each device's own peak (3000 + 2000)
    expect(lb?.peakVramMiB).toBe(3500);
    expect(lb?.peakUtilPct).toBe(60);
    expect(lb?.lastBusy).toBe(at(0) * 1000);
  });

  it("uses the profiling counter for utilisation on MIG slices, as a percentage", () => {
    const slice = { gpu: "0", GPU_I_ID: "8", GPU_I_PROFILE: "1g.10gb", namespace: "ml", pod: "embed-0" };
    const lb = run({
      DCGM_FI_PROF_GR_ENGINE_ACTIVE: matrix(series(slice, [0.42, 0.01])),
      DCGM_FI_DEV_FB_USED: matrix(series(slice, [2100, 2100])),
    }).get("ml/embed-0");
    expect(lb?.peakUtilPct).toBeCloseTo(42);
    expect(lb?.idleShare).toBe(0.5);
  });

  it("prefers the per-process exporter for a pod it reports, in MiB", () => {
    const dcgm = { gpu: "0", UUID: "GPU-a", namespace: "ml", pod: "shared-0" };
    const proc = { gpu: "0", uuid: "GPU-a", namespace: "ml", pod: "shared-0", pid: "41" };
    const lb = run({
      DCGM_FI_DEV_GPU_UTIL: matrix(series(dcgm, [90, 90])), // device-level: the neighbour's work
      DCGM_FI_DEV_FB_USED: matrix(series(dcgm, [70000, 70000])),
      gpu_process_utilization_percent: matrix(series(proc, [1, 0])),
      gpu_process_memory_bytes: matrix(series(proc, [3 * 1024 ** 3, 2 * 1024 ** 3])),
    }).get("ml/shared-0");
    expect(lb?.peakVramMiB).toBe(3072);
    expect(lb?.peakUtilPct).toBe(1);
    expect(lb?.lastBusy).toBeUndefined();
  });

  it("keeps the peak VRAM of a pod that has no utilisation series", () => {
    const lb = run({
      DCGM_FI_DEV_FB_USED: matrix(series({ gpu: "0", namespace: "ml", pod: "p" }, [100, 900])),
    }).get("ml/p");
    expect(lb).toEqual({ firstSeen: (T0 - STEP) * 1000, peakVramMiB: 900, observedMs: 0 });
  });

  it("reports a failed query instead of an empty history", () => {
    expect(() => run({ DCGM_FI_DEV_FB_USED: JSON.stringify({ status: "error", error: "query timed out" }) })).toThrow(
      "query timed out",
    );
    expect(() => run({ DCGM_FI_DEV_FB_USED: "<html>502</html>" })).toThrow(/not a Prometheus API response/);
  });
});

describe("idleStretch", () => {
  const now = at(20) * 1000;
  const sample = (minutesAgo: number, utilPct: number) => ({ t: now - minutesAgo * 60_000, utilPct, vramUsedMiB: 1 });
  const base = { firstSeen: 0, peakVramMiB: 1, observedMs: 1 };

  it("trusts a busy sample of the session over the lookback", () => {
    const h = [sample(3, 0), sample(2, 50), sample(1, 0), sample(0, 0)];
    expect(idleStretch(h, { ...base, utilFrom: 0 }, now, 5)).toEqual({
      since: now - 60_000,
      samples: 2,
      atLeast: false,
      from: "session",
    });
  });

  it("reaches back to the last busy step when the whole session is idle", () => {
    const h = [sample(1, 0), sample(0, 0)];
    const lastBusy = now - 3 * 86_400_000;
    expect(idleStretch(h, { ...base, utilFrom: 0, lastBusy }, now, 5)).toEqual({
      since: lastBusy,
      samples: 2,
      atLeast: false,
      from: "lookback",
    });
  });

  it("gives a lower bound for a pod that was never seen busy", () => {
    const h = [sample(1, 0), sample(0, 0)];
    const utilFrom = now - 7 * 86_400_000;
    expect(idleStretch(h, { ...base, utilFrom }, now, 5)).toMatchObject({
      since: utilFrom,
      atLeast: true,
      from: "lookback",
    });
    // without a lookback the session is all there is, and it is a lower bound too
    expect(idleStretch(h, undefined, now, 5)).toMatchObject({ since: now - 60_000, atLeast: true, from: "session" });
  });

  it("takes a burst the lookback caught between two idle scrapes of the session", () => {
    const h = [sample(120, 0), sample(0, 0)];
    const lastBusy = now - 30 * 60_000;
    expect(idleStretch(h, { ...base, utilFrom: 0, lastBusy }, now, 5).since).toBe(lastBusy);
  });
});
