import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateByPod,
  aggregateDevicesDcgm,
  attributedPower,
  devicePowerShares,
  extractDcgmSamples,
  totalPowerW,
} from "../aggregate";
import { aggregateNamespaces, migFree } from "../namespaces";
import { parsePrometheusText } from "../prom";

import type { GpuDevice, PodGPU } from "../types";

const dgx = parsePrometheusText(readFileSync(join(__dirname, "fixtures", "dgx_a100_mig_mixed.prom"), "utf8"));

const row = (ns: string, pod: string, over: Partial<PodGPU> = {}): PodGPU => ({
  namespace: ns,
  pod,
  node: "n",
  gpus: ["0"],
  gpuCount: 1,
  gpuUtilPct: 0,
  vramUsedMiB: 0,
  vramFreeMiB: 0,
  powerWatts: 0,
  ...over,
});

describe("aggregateNamespaces", () => {
  it("rolls the real DGX capture up to its namespaces, one device per MIG pod", () => {
    const rows = aggregateByPod(extractDcgmSamples(dgx, "dgx-1"));
    const ns = aggregateNamespaces({}, rows, [], []);
    expect(ns.map((r) => r.namespace).sort()).toEqual(["ns-0", "ns-1", "ns-2", "ns-3"]);
    expect(ns.reduce((s, r) => s + r.devicesInUse, 0)).toBe(29);
    expect(ns.reduce((s, r) => s + r.vramUsedMiB, 0)).toBe(rows.reduce((s, r) => s + r.vramUsedMiB, 0));
  });

  it("joins requests, measured use, idle holders and waiting pods", () => {
    const ns = aggregateNamespaces(
      {
        ml: { gpus: 3, byResource: { "nvidia.com/mig-1g.10gb": 2, "nvidia.com/gpu": 1 }, pods: ["ml/a", "ml/b"] },
        empty: { gpus: 1, byResource: { "nvidia.com/gpu": 1 }, pods: ["empty/x"] },
      },
      [
        row("ml", "a", { gpuUtilPct: 80, vramUsedMiB: 1000, powerWatts: 100 }),
        row("ml", "b", { gpus: ["1"], gpuUtilPct: 0, vramUsedMiB: 3000, powerWatts: 50, sharedWith: 2 }), // shares GPU 1 with another namespace
        row("-", "(gpu 3)", { gpuIndex: "3" }), // fallback rows carry no namespace
      ],
      [row("ml", "b", { vramUsedMiB: 3000 })],
      [{ namespace: "queue", pod: "w", requests: { "nvidia.com/gpu": 1 } }],
    );
    const ml = ns.find((r) => r.namespace === "ml");
    expect(ml).toMatchObject({
      requested: 3,
      gpuPods: 2,
      devicesInUse: 2,
      avgUtilPct: 40,
      vramUsedMiB: 4000,
      idlePods: 1,
      idleVramMiB: 3000,
      powerWatts: 150,
      shared: true,
    });
    // requested but nothing measured: the "idle reservation" case
    expect(ns.find((r) => r.namespace === "empty")).toMatchObject({ requested: 1, devicesInUse: 0, avgUtilPct: 0 });
    expect(ns.find((r) => r.namespace === "queue")).toMatchObject({ requested: 0, pending: 1 });
    expect(ns.some((r) => r.namespace === "-")).toBe(false);
    expect(ns[0].namespace).toBe("ml"); // most requested first
  });
});

describe("aggregateNamespaces, shared devices", () => {
  it("counts a GPU shared by two pods of one namespace once, and marks power as an upper bound", () => {
    const [ml] = aggregateNamespaces(
      {},
      [
        row("ml", "a", { gpus: ["0"], sharedWith: 2, powerWatts: 300 }),
        row("ml", "b", { gpus: ["0"], sharedWith: 2, powerWatts: 300 }),
      ],
      [],
      [],
    );
    expect(ml).toMatchObject({ devicesInUse: 1, powerWatts: 600, shared: true });
  });
  it("treats a time-sliced row as shared even when the exporter attributes the device to one pod", () => {
    const [ml] = aggregateNamespaces({}, [row("ml", "a", { timeSliced: true })], [], []);
    expect(ml.shared).toBe(true);
  });
  it("counts per-process rows without device ids by their gpuCount", () => {
    const [ml] = aggregateNamespaces({}, [row("ml", "a", { gpus: [], gpuCount: 2 })], [], []);
    expect(ml.devicesInUse).toBe(2);
  });
});

describe("migFree", () => {
  it("klabdgx 2026-09-24: 28 x 1g.10gb and 1 x 3g.40gb requested", () => {
    expect(
      migFree(
        {
          "nvidia.com/gpu": 1,
          "nvidia.com/mig-1g.10gb": 46,
          "nvidia.com/mig-1g.10gb.shared": 0,
          "nvidia.com/mig-3g.40gb": 1,
        },
        { "nvidia.com/mig-1g.10gb": 28, "nvidia.com/mig-3g.40gb": 1 },
      ),
    ).toEqual([
      { profile: "1g.10gb", free: 18, total: 46 },
      { profile: "3g.40gb", free: 0, total: 1 },
    ]);
  });
  it("is empty for a node without MIG and never negative", () => {
    expect(migFree({ "nvidia.com/gpu": 8 }, { "nvidia.com/gpu": 8 })).toEqual([]);
    expect(migFree({ "nvidia.com/mig-1g.10gb": 2 }, { "nvidia.com/mig-1g.10gb": 5 })[0].free).toBe(0);
  });
});

describe("MIG power attribution", () => {
  it("real DGX capture: per-pod and per-namespace power add up to the cards, not to cards x slices", () => {
    const devs = aggregateDevicesDcgm(dgx, "dgx-1");
    const shares = devicePowerShares(devs);
    const rows = aggregateByPod(extractDcgmSamples(dgx, "dgx-1")).map((r) => ({
      ...r,
      powerWatts: attributedPower(r, shares),
    }));
    const podPower = rows.reduce((s, r) => s + r.powerWatts, 0);
    // 29 pods on MIG slices: before, each carried its card's ~104 W (~3,000 W in total)
    expect(podPower).toBeLessThanOrEqual(totalPowerW(devs));
    expect(podPower).toBeGreaterThan(300);
    const ns = aggregateNamespaces({}, rows, [], []);
    expect(ns.reduce((s, n) => s + n.powerWatts, 0)).toBeCloseTo(podPower, 6);
  });
  it("weights a slice by its compute size among the card's slices", () => {
    const slice = (gpu: string, profile: string): GpuDevice => ({
      node: "n",
      gpu,
      uuid: "GPU-a",
      migProfile: profile,
      utilPct: 0,
      vramUsedMiB: 0,
      vramTotalMiB: 0,
      powerWatts: 140,
      pods: [],
    });
    const shares = devicePowerShares([
      slice("2:2", "3g.40gb"),
      slice("2:7", "1g.10gb"),
      slice("2:8", "1g.10gb"),
      slice("2:9", "1g.10gb"),
      slice("2:10", "1g.10gb"),
    ]);
    expect(shares.get("n/2:2")).toBeCloseTo(60); // 3/7 of 140 W
    expect(shares.get("n/2:7")).toBeCloseTo(20); // 1/7
    expect([...shares.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(140);
  });
  it("leaves whole GPUs and per-process rows alone", () => {
    const whole: GpuDevice = {
      node: "n",
      gpu: "4",
      utilPct: 0,
      vramUsedMiB: 0,
      vramTotalMiB: 0,
      powerWatts: 66,
      pods: [],
    };
    const shares = devicePowerShares([whole]);
    expect(attributedPower(row("ml", "a", { source: "dcgm", gpus: ["4"], powerWatts: 66 }), shares)).toBe(66);
    expect(attributedPower(row("ml", "b", { source: "enricher", gpus: ["4"], powerWatts: 12 }), shares)).toBe(12);
  });
});
