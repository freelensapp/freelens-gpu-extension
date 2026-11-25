import { autorun, isObservableProp, runInAction } from "mobx";
import { describe, expect, it } from "vitest";
import { GpuStore } from "../store";

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
