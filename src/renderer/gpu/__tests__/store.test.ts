import { autorun, isObservableProp, runInAction } from "mobx";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GpuStore, LOOKBACK_LAG_MS } from "../store";

import type { GpuScraper } from "../scraper";
import type { Snapshot } from "../types";

const snapshot = {
  scrapedAt: new Date("2026-10-12T09:00:00Z"),
  mode: "pod",
  rows: [],
  gpus: [],
  exporters: [{ namespace: "gpu-operator", name: "dcgm-a", port: 9400, nodeName: "n1", kind: "dcgm" }],
} as unknown as Snapshot;

// Importing the class is itself part of the test: the development build of
// mobx, which Vitest runs, throws when a class is defined with `@observable`
// on a field that is not an `accessor`.
describe("GpuStore", () => {
  it("makes its decorated fields observable", () => {
    const store = new GpuStore();

    for (const field of [
      "snapshot",
      "pins",
      "inference",
      "podState",
      "error",
      "loading",
      "nodes",
      "nodesError",
      "historyVersion",
      "lookback",
      "lookbackWindow",
      "lookbackLoading",
    ]) {
      expect(isObservableProp(store, field)).toBe(true);
    }
  });

  it("re-runs a reaction on its computed values when an observable changes", () => {
    const store = new GpuStore();
    const seen: boolean[] = [];
    const dispose = autorun(() => seen.push(store.hasGpus));

    runInAction(() => {
      store.snapshot = snapshot;
    });
    dispose();

    expect(seen).toEqual([false, true]);
  });

  it("keeps a pod's history through a refresh where no exporter answered, and resumes when one does", async () => {
    const ex = { namespace: "gpu-operator", name: "dcgm-a", port: 9400, nodeName: "n1", kind: "dcgm" };
    const pod = {
      namespace: "ml",
      pod: "train",
      node: "n1",
      gpus: ["0"],
      gpuCount: 1,
      gpuUtilPct: 0,
      vramUsedMiB: 2000,
      vramFreeMiB: 0,
      powerWatts: 0,
    };
    // A DRA-only snapshot, as the scraper returns it when no exporter answers: no rows and no exporters.
    const snap = (at: number, answered: boolean): Snapshot =>
      ({
        scrapedAt: new Date(at),
        mode: "pod",
        rows: answered ? [pod] : [],
        gpus: [],
        exporters: answered ? [ex] : [],
      }) as unknown as Snapshot;
    let next = snap(1_000, true);
    const scraper = {
      snapshot: async () => next,
      scrapeInference: async () => [],
      pins: [],
      metricsNote: "",
      podState: undefined,
      draNote: undefined,
      lastProbes: [],
      invalidate: () => {},
    };
    const store = new GpuStore(scraper as unknown as GpuScraper);
    const samples = (): number[] =>
      ((store as unknown as { history: Map<string, { t: number }[]> }).history.get("ml/train") ?? []).map((s) => s.t);

    await store.refresh(true);
    expect(samples()).toEqual([1_000]);

    next = snap(2_000, false);
    await store.refresh(true);
    expect(samples()).toEqual([1_000]);

    next = snap(3_000, true);
    await store.refresh(true);
    expect(samples()).toEqual([1_000, 3_000]);
  });

  it("lists an idle pod on Idle & waste but not one whose utilisation the exporter does not publish", () => {
    const row = (pod: string, over: object = {}) => ({
      namespace: "dra-test",
      pod,
      node: "n1",
      gpus: ["12"],
      gpuCount: 1,
      gpuUtilPct: 0,
      vramUsedMiB: 2000,
      vramFreeMiB: 0,
      powerWatts: 0,
      ...over,
    });
    const store = new GpuStore();

    runInAction(() => {
      store.snapshot = {
        ...snapshot,
        rows: [row("idle"), row("unmeasured", { gpus: ["13"], utilUnpublished: true })],
      } as unknown as Snapshot;
    });

    expect(store.idleRows.map((r) => r.pod)).toEqual(["idle"]);
    // It is still a pod row, with its VRAM: only the idle verdict is withheld.
    expect(store.rows.map((r) => r.pod).sort()).toEqual(["idle", "unmeasured"]);
  });
});

describe("GpuStore lookback", () => {
  const STEP = 1800;
  const row = { namespace: "ml", pod: "trainer-0", node: "n1", gpus: ["0"], gpuCount: 1, gpuUtilPct: 0 };
  const idleSnapshot = (at: Date) =>
    ({
      scrapedAt: at,
      mode: "pod",
      rows: [{ ...row, vramUsedMiB: 41000, vramFreeMiB: 40000, powerWatts: 60 }],
      gpus: [],
      exporters: [],
    }) as unknown as Snapshot;

  /** A scraper whose query API saw the pod busy until `busySteps` steps ago and idle since. */
  const fakeScraper = (nowMs: number, busySteps: number, fail = false) => {
    const end = Math.floor(nowMs / 1000 / STEP) * STEP;
    const values = (f: (i: number) => number): [number, string][] =>
      Array.from({ length: 48 }, (_, i) => [end - (47 - i) * STEP, String(f(47 - i))]);
    const matrix = (vals: [number, string][]) =>
      JSON.stringify({
        status: "success",
        data: { result: [{ metric: { gpu: "0", namespace: "ml", pod: "trainer-0" }, values: vals }] },
      });
    const empty = JSON.stringify({ status: "success", data: { result: [] } });
    return {
      pins: [],
      lookback: async () => {
        if (fail) throw new Error("HTTP 403 Forbidden");
        return {
          target: { namespace: "mon", name: "prometheus-server", port: 80 },
          stepS: STEP,
          results: [
            { metric: "DCGM_FI_DEV_GPU_UTIL", json: matrix(values((ago) => (ago >= busySteps ? 95 : 0))) },
            { metric: "DCGM_FI_PROF_GR_ENGINE_ACTIVE", json: empty },
            { metric: "DCGM_FI_DEV_FB_USED", json: matrix(values((ago) => (ago >= busySteps ? 78000 : 41000))) },
            { metric: "gpu_process_utilization_percent", json: empty },
            { metric: "gpu_process_memory_bytes", json: empty },
          ],
        };
      },
    } as never;
  };

  it("extends the idle time, the peaks and the idle share of an idle pod with the history of the query API", async () => {
    const now = Date.now();
    const store = new GpuStore(fakeScraper(now, 10));
    runInAction(() => {
      store.snapshot = idleSnapshot(new Date(now));
    });

    // without the lookback: nothing older than this session is known
    expect(store.idleRows[0]).toMatchObject({ idleAtLeast: false, peakUtilPct: 0 });
    expect(store.idleRows[0].idleMinutes).toBeLessThan(1);
    expect(store.idleRows[0].lookback).toBeUndefined();

    await store.refreshLookback();
    expect(store.lookback).toMatchObject({ window: "7d", source: "mon/svc/prometheus-server:80" });
    const idle = store.idleRows[0];
    // the last busy step ended 10 steps before the newest one: idle for 5 h plus the part of a step since then
    expect(idle.idleMinutes).toBeGreaterThanOrEqual(10 * 30);
    expect(idle.idleMinutes).toBeLessThan(11 * 30);
    expect(idle.idleAtLeast).toBe(false);
    expect(idle.peakUtilPct).toBe(95);
    expect(idle.lookback).toMatchObject({ peakVramMiB: 78000, idleShare: 10 / 48 });
  });

  it("keeps the session's numbers and the reason when the history cannot be read", async () => {
    const now = Date.now();
    const store = new GpuStore(fakeScraper(now, 10, true));
    runInAction(() => {
      store.snapshot = idleSnapshot(new Date(now));
    });
    await store.refreshLookback();
    expect(store.lookback).toMatchObject({ error: "HTTP 403 Forbidden" });
    expect(store.lookback?.source).toBeUndefined();
    expect(store.lookbackLoading).toBe(false);
    expect(store.idleRows[0]).toMatchObject({ idleAtLeast: false });
    expect(store.idleRows[0].lookback).toBeUndefined();
  });

  it("ignores a lookback read for another window until the new one arrives", async () => {
    const now = Date.now();
    const store = new GpuStore(fakeScraper(now, 10));
    runInAction(() => {
      store.snapshot = idleSnapshot(new Date(now));
    });
    await store.refreshLookback();
    runInAction(() => {
      store.lookbackWindow = "24h";
    });
    expect(store.idleRows[0].lookback).toBeUndefined();
    await store.refreshLookback();
    expect(store.lookback?.window).toBe("24h");
    expect(store.idleRows[0].lookback).toBeDefined();
  });

  describe("schedule", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** A scraper that counts its reads, per window. */
    const countingScraper = () => {
      const reads: string[] = [];
      return {
        reads,
        scraper: {
          pins: [],
          lookback: async (window: string) => {
            reads.push(window);
            return undefined;
          },
        } as never,
      };
    };

    it("reads each window again only when a step of it has closed", async () => {
      vi.useFakeTimers();
      // just after a 30 min step boundary has become readable
      const t0 = Date.UTC(2026, 10, 25, 10, 0, 0) + LOOKBACK_LAG_MS;
      vi.setSystemTime(t0);
      const { reads, scraper } = countingScraper();
      const store = new GpuStore(scraper);

      const stop = store.subscribeLookback();
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toEqual(["7d"]);

      // 7 d moves by 30 min: nothing new to read for 29 minutes
      await vi.advanceTimersByTimeAsync(29 * 60_000);
      expect(reads).toEqual(["7d"]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reads).toEqual(["7d", "7d"]);

      // 24 h moves by 5 min: read at once on the switch, then every 5 minutes
      store.setLookbackWindow("24h");
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toEqual(["7d", "7d", "24h"]);
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(reads).toEqual(["7d", "7d", "24h", "24h", "24h", "24h"]);

      stop();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(reads).toHaveLength(6);
    });

    it("does not read again when the view is reopened within the same step", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.UTC(2026, 10, 25, 10, 0, 0) + LOOKBACK_LAG_MS);
      const { reads, scraper } = countingScraper();
      const store = new GpuStore(scraper);
      store.subscribeLookback()();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      store.subscribeLookback()();
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toEqual(["7d"]);
    });

    it("tries a failed read again after 5 minutes, also on the 7 d window", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.UTC(2026, 10, 25, 10, 0, 0) + LOOKBACK_LAG_MS);
      let calls = 0;
      const store = new GpuStore({
        pins: [],
        lookback: async () => {
          calls++;
          throw new Error("HTTP 503 Service Unavailable");
        },
      } as never);
      const stop = store.subscribeLookback();
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toBe(2);
      stop();
    });
  });
});
