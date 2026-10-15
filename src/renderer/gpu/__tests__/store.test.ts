import { autorun, isObservableProp, runInAction } from "mobx";
import { describe, expect, it } from "vitest";
import { GpuStore } from "../store";

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
});
