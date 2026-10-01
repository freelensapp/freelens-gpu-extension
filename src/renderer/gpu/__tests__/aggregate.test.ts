import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateByGPU,
  aggregateByPod,
  aggregateDevicesDcgm,
  aggregateDevicesEnricher,
  buildEnricherRows,
  deviceHealth,
  extractDcgmSamples,
  gpuResourceCount,
  nodeHealth,
  podsPerDevice,
  rowHealth,
  sharedWith,
  sortDevices,
  sortRows,
  totalPowerW,
  usesGpuResource,
} from "../aggregate";
import { classifyMetrics, parsePrometheusText } from "../prom";

import type { GpuDevice, PodGPU } from "../types";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const fams = (name: string) => parsePrometheusText(fixture(name));
const byPod = (rows: PodGPU[], ns: string, pod: string): PodGPU => {
  const r = rows.find((x) => x.namespace === ns && x.pod === pod);
  if (!r) throw new Error(`row ${ns}/${pod} missing in ${JSON.stringify(rows)}`);
  return r;
};

describe("prom parser", () => {
  it("parses labels, values and escapes", () => {
    const f = parsePrometheusText(
      'a_b{x="1",y="q\\"uote",z="back\\\\slash"} 12.5 1700000000\nplain 3\n# comment\n\nnan_v NaN\n',
    );
    expect(f.get("a_b")?.[0]).toEqual({ name: "a_b", labels: { x: "1", y: 'q"uote', z: "back\\slash" }, value: 12.5 });
    expect(f.get("plain")?.[0].value).toBe(3);
    expect(Number.isNaN(f.get("nan_v")?.[0].value)).toBe(true);
  });
  it("classifies exporters by metric content", () => {
    expect(classifyMetrics(fixture("dcgm_pod_labels.prom"))).toBe("dcgm");
    expect(classifyMetrics(fixture("dcgm_mig.prom"))).toBe("dcgm");
    expect(classifyMetrics(fixture("enricher.prom"))).toBe("enricher");
    expect(classifyMetrics("http_requests_total 1")).toBeUndefined();
  });
});

describe("dcgm pod attribution", () => {
  const rows = aggregateByPod(extractDcgmSamples(fams("dcgm_pod_labels.prom"), "exporter-node"));
  it("drops unattributed GPUs and aggregates multi-GPU pods", () => {
    expect(rows).toHaveLength(2);
    const vllm = byPod(rows, "ml", "vllm-0");
    expect(vllm.gpus).toEqual(["0", "1"]);
    expect(vllm.gpuCount).toBe(2);
    expect(vllm.gpuUtilPct).toBe(65);
    expect(vllm.vramUsedMiB).toBe(135000);
    expect(vllm.vramUsedMiB + vllm.vramFreeMiB).toBe(162000);
    expect(vllm.powerWatts).toBe(511);
    expect(vllm.node).toBe("exporter-node"); // exporter pod's nodeName wins over the Hostname label
  });
  it("uses the Hostname label only when the exporter node is unknown", () => {
    const r = aggregateByPod(extractDcgmSamples(fams("dcgm_pod_labels.prom"), ""));
    expect(byPod(r, "ml", "vllm-0").node).toBe("node-a");
  });
  it("falls back to per-GPU rows for unattributed samples", () => {
    const un = extractDcgmSamples(fams("dcgm_pod_labels.prom"), "exporter-node").filter((s) => !s.pod);
    const fb = aggregateByGPU(un);
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ namespace: "-", pod: "(gpu 3)", gpuIndex: "3", gpus: ["3"], powerWatts: 55 });
    expect(fb[0].vramUsedMiB + fb[0].vramFreeMiB).toBe(81000);
  });
});

describe("dcgm MIG", () => {
  const rows = aggregateByPod(extractDcgmSamples(fams("dcgm_mig.prom"), "dgx-1"));
  it("keys on gpu:GPU_I_ID and scales PROF_GR_ENGINE_ACTIVE to percent", () => {
    expect(rows).toHaveLength(4);
    const t0 = byPod(rows, "it-dgx1", "transcription-0");
    expect(t0.gpus).toEqual(["0:7"]);
    expect(t0.gpuUtilPct).toBeCloseTo(42);
    const ocr = byPod(rows, "it-dgx2", "ocr-0");
    expect(ocr.vramUsedMiB).toBe(9000);
    expect(ocr.vramUsedMiB + ocr.vramFreeMiB).toBe(9700);
  });
  it("sorts slices of the same card together, card 0 before card 1", () => {
    expect(sortRows(rows).map((r) => r.gpus[0])).toEqual(["0:7", "0:8", "0:9", "1:1"]);
  });
});

describe("per-process exporter", () => {
  const rows = buildEnricherRows([{ fams: fams("enricher.prom"), node: "gpu-node-1" }]);
  it("sums VRAM per pod, max util, proportional power", () => {
    expect(rows).toHaveLength(3);
    const vllm = byPod(rows, "ml", "vllm-0");
    expect(vllm.vramUsedMiB).toBe(50 * 1024);
    expect(vllm.gpuUtilPct).toBe(60);
    expect(vllm.powerWatts).toBeCloseTo(250);
    const tei1 = byPod(rows, "embeddings", "tei-1");
    expect(tei1.powerWatts).toBeCloseTo(100);
    expect(tei1.node).toBe("gpu-node-1");
    expect(byPod(rows, "embeddings", "tei-2").gpus).toEqual(["1"]);
  });
});

describe("per-device aggregation", () => {
  it("dcgm: one device per card with model, temp, totals and pod set", () => {
    const devs = sortDevices(aggregateDevicesDcgm(fams("dcgm_pod_labels.prom"), "exporter-node"));
    expect(devs.map((d) => d.gpu)).toEqual(["0", "1", "2", "3"]);
    const g0 = devs[0];
    expect(g0).toMatchObject({
      node: "exporter-node",
      uuid: "GPU-aaaa",
      model: "NVIDIA A100-SXM4-80GB",
      utilPct: 87,
      tempC: 71,
    });
    expect(g0.vramUsedMiB).toBe(70000);
    expect(g0.vramTotalMiB).toBe(81000);
    expect(g0.pods).toEqual(["ml/vllm-0"]);
    expect(devs[3].pods).toEqual([]); // unattributed card still listed
    expect(devs[3].powerWatts).toBe(55);
  });
  it("dcgm MIG: one device per slice with profile", () => {
    const devs = sortDevices(aggregateDevicesDcgm(fams("dcgm_mig.prom"), "dgx-1"));
    expect(devs.map((d) => d.gpu)).toEqual(["0:7", "0:8", "0:9", "1:1"]);
    expect(devs[0]).toMatchObject({
      migProfile: "1g.10gb",
      utilPct: 42,
      vramUsedMiB: 6000,
      vramTotalMiB: 9700,
      pods: ["it-dgx1/transcription-0"],
    });
  });
  it("enricher: totals per uuid, usage summed, pods collected", () => {
    const devs = sortDevices(aggregateDevicesEnricher([{ fams: fams("enricher.prom"), node: "gpu-node-1" }]));
    expect(devs).toHaveLength(2);
    const g0 = devs[0];
    expect(g0).toMatchObject({
      node: "gpu-node-1",
      gpu: "0",
      uuid: "GPU-aaaa",
      powerWatts: 400,
      vramTotalMiB: 80 * 1024,
    });
    expect(g0.vramUsedMiB).toBe(70 * 1024); // 40+10+20 GiB
    expect(g0.utilPct).toBe(60); // max process util (no device-level gauge in fixture)
    expect(g0.pods).toEqual(["embeddings/tei-1", "ml/vllm-0"]);
  });
});

describe("util source precedence", () => {
  // Non-MIG cards with DCP metrics enabled emit GPU_UTIL and PROF_GR_ENGINE_ACTIVE for the same GPU.
  const both = parsePrometheusText(
    [
      'DCGM_FI_DEV_GPU_UTIL{gpu="0",UUID="GPU-a",namespace="ml",pod="p"} 80',
      'DCGM_FI_PROF_GR_ENGINE_ACTIVE{gpu="0",UUID="GPU-a",namespace="ml",pod="p"} 0.7',
      'DCGM_FI_DEV_GPU_UTIL{gpu="1",UUID="GPU-b",namespace="ml",pod="p"} 40',
      'DCGM_FI_PROF_GR_ENGINE_ACTIVE{gpu="1",UUID="GPU-b",namespace="ml",pod="p"} 0.9',
    ].join("\n"),
  );
  it("pod rows use GPU_UTIL and do not add GR_ENGINE_ACTIVE on top", () => {
    const [row] = aggregateByPod(extractDcgmSamples(both, "n"));
    expect(row.gpuCount).toBe(2);
    expect(row.gpuUtilPct).toBe(60);
  });
  it("devices prefer GPU_UTIL even when GR_ENGINE_ACTIVE is higher", () => {
    const devs = sortDevices(aggregateDevicesDcgm(both, "n"));
    expect(devs.map((d) => d.utilPct)).toEqual([80, 40]);
  });
});

describe("power and resource totals", () => {
  it("counts a MIG card's power once, not once per slice", () => {
    const f = parsePrometheusText(
      [7, 8, 9]
        .map((id) => `DCGM_FI_DEV_POWER_USAGE{gpu="0",UUID="GPU-a",GPU_I_ID="${id}",GPU_I_PROFILE="1g.10gb"} 250`)
        .concat(['DCGM_FI_DEV_POWER_USAGE{gpu="1",UUID="GPU-b"} 100'])
        .join("\n"),
    );
    const devs = aggregateDevicesDcgm(f, "dgx-1");
    expect(devs).toHaveLength(4);
    expect(totalPowerW(devs)).toBe(350);
  });
  it("counts nvidia.com/gpu and MIG resources (mig.strategy=mixed)", () => {
    expect(
      gpuResourceCount({
        "nvidia.com/gpu": "2",
        "nvidia.com/mig-1g.10gb": "7",
        "nvidia.com/mig-3g.40gb": "2",
        cpu: "96",
      }),
    ).toBe(11);
    expect(gpuResourceCount(undefined)).toBe(0);
    // klabdgx node status, 2026-09-24: 1 whole GPU + 46 + 1 MIG slices; *.shared are replicas, not devices
    expect(
      gpuResourceCount({
        "nvidia.com/gpu": "1",
        "nvidia.com/mig-1g.10gb": "46",
        "nvidia.com/mig-1g.10gb.shared": "0",
        "nvidia.com/mig-3g.40gb": "1",
      }),
    ).toBe(48);
    expect(gpuResourceCount({ "nvidia.com/gpu.shared": "8", "nvidia.com/mig-1g.10gb.shared": "4" })).toBe(0);
  });
  it("treats time-sliced *.shared requests as using a GPU", () => {
    expect(usesGpuResource({ "nvidia.com/gpu.shared": "1" })).toBe(true);
    expect(usesGpuResource({ "nvidia.com/mig-1g.10gb": "1" })).toBe(true);
    expect(usesGpuResource({ "nvidia.com/gpu": "0", cpu: "4" })).toBe(false);
    expect(usesGpuResource(undefined)).toBe(false);
  });
});

describe("real DGX capture (A100 x8, MIG mixed, redacted)", () => {
  const f = fams("dgx_a100_mig_mixed.prom");
  const devs = aggregateDevicesDcgm(f, "dgx-1");
  it("matches what the live cluster showed on 2026-09-24", () => {
    expect(devs).toHaveLength(48);
    expect(devs.filter((d) => d.migProfile)).toHaveLength(47);
    expect(Math.round(totalPowerW(devs))).toBe(805); // 5,033 W if summed per slice
    expect(aggregateByPod(extractDcgmSamples(f, "dgx-1"))).toHaveLength(29);
  });
  it("reads the profiling counters as percentages where exported", () => {
    expect(devs.every((d) => d.tensorActivePct !== undefined && d.dramActivePct !== undefined)).toBe(true);
    expect(devs.every((d) => d.smActivePct === undefined)).toBe(true); // SM_ACTIVE is not in this exporter's CSV
    expect(Math.max(...devs.map((d) => d.dramActivePct ?? 0))).toBeCloseTo(0.0024);
  });
});

describe("shared devices", () => {
  const two = parsePrometheusText(
    [
      'DCGM_FI_DEV_GPU_UTIL{gpu="0",UUID="GPU-a",namespace="ml",pod="a"} 90',
      'DCGM_FI_DEV_GPU_UTIL{gpu="0",UUID="GPU-a",namespace="ml",pod="b"} 90',
      'DCGM_FI_DEV_GPU_UTIL{gpu="1",UUID="GPU-b",namespace="ml",pod="c"} 10',
    ].join("\n"),
  );
  const perDevice = podsPerDevice(aggregateDevicesDcgm(two, "n"));
  const rows = aggregateByPod(extractDcgmSamples(two, "n"));
  it("marks DCGM rows whose device carries several pods", () => {
    expect(sharedWith(byPod(rows, "ml", "a"), perDevice)).toBe(2);
    expect(sharedWith(byPod(rows, "ml", "c"), perDevice)).toBe(1);
  });
  it("counts only pods the exporter attributes, never a node's time-slicing replica count", () => {
    // replicas are a separate flag (PodGPU.timeSliced); a lone pod must not read "shared x4"
    expect(sharedWith(byPod(rows, "ml", "c"), perDevice)).toBe(1);
  });
  it("never marks per-process exporter rows: they are already split per pod", () => {
    const [r] = buildEnricherRows([{ fams: fams("enricher.prom"), node: "gpu-node-1" }]);
    expect(r.source).toBe("enricher");
    expect(sharedWith(r, new Map([["gpu-node-1/0", 3]]))).toBe(1);
  });
});

describe("device health", () => {
  it("real capture: the whole GPU reports remap state (OK), MIG slices report nothing", () => {
    const devs = aggregateDevicesDcgm(fams("dgx_a100_mig_mixed.prom"), "dgx-1");
    const whole = devs.find((d) => d.gpu === "4");
    expect(whole && deviceHealth(whole)).toEqual({ level: "ok", text: "OK" });
    const slices = devs.filter((d) => d.migProfile).map((d) => deviceHealth(d).level);
    expect(new Set(slices)).toEqual(new Set(["unknown"])); // never a reassuring "ok" without data
  });
  it("flags XID, uncorrectable ECC and row remap failure as bad, pending remap as warn", () => {
    const f = parsePrometheusText(
      [
        'DCGM_FI_DEV_XID_ERRORS{gpu="0",UUID="GPU-a"} 79',
        'DCGM_FI_DEV_ECC_DBE_VOL_TOTAL{gpu="1",UUID="GPU-b"} 2',
        'DCGM_FI_DEV_ROW_REMAP_FAILURE{gpu="2",UUID="GPU-c"} 1',
        'DCGM_FI_DEV_UNCORRECTABLE_REMAPPED_ROWS{gpu="3",UUID="GPU-d"} 3',
        'DCGM_FI_DEV_XID_ERRORS{gpu="4",UUID="GPU-e"} 0',
      ].join("\n"),
    );
    const h = sortDevices(aggregateDevicesDcgm(f, "n")).map((d) => deviceHealth(d));
    expect(h).toEqual([
      { level: "bad", text: "last XID 79: GPU has fallen off the bus" },
      { level: "bad", text: "2 uncorrectable ECC" },
      { level: "bad", text: "row remap failed" },
      { level: "warn", text: "3 rows remapped (reset pending)" },
      { level: "ok", text: "OK" },
    ]);
  });
});

describe("node health", () => {
  const dev = (gpu: string, over: Partial<GpuDevice> = {}): GpuDevice => ({
    node: "n",
    gpu,
    utilPct: 0,
    vramUsedMiB: 0,
    vramTotalMiB: 0,
    powerWatts: 0,
    pods: [],
    ...over,
  });
  it("is bad when the device plugin withdrew devices, even without health gauges", () => {
    expect(nodeHealth([dev("0")], 2)).toEqual({ level: "bad", text: "2 withdrawn" });
  });
  it("takes the worst device and lists what is wrong", () => {
    expect(
      nodeHealth([dev("0", { lastXid: 0 }), dev("1", { lastXid: 79 }), dev("2", { uncorrectableRemappedRows: 1 })]),
    ).toEqual({
      level: "bad",
      text: "GPU 1 last XID 79: GPU has fallen off the bus, GPU 2 1 rows remapped (reset pending)",
    });
    expect(nodeHealth([dev("0", { uncorrectableRemappedRows: 3 })]).level).toBe("warn");
  });
  it("real capture: OK from the one reporting GPU, and says how many report", () => {
    const devs = aggregateDevicesDcgm(fams("dgx_a100_mig_mixed.prom"), "dgx-1");
    expect(nodeHealth(devs)).toEqual({ level: "ok", text: "OK (1 of 48 report)" });
    expect(nodeHealth(devs.filter((d) => d.migProfile))).toEqual({ level: "unknown", text: "not exported" });
  });
});

describe("XID meanings and throttle reasons", () => {
  const dev = (over: Partial<GpuDevice>): GpuDevice => ({
    node: "n",
    gpu: "0",
    utilPct: 0,
    vramUsedMiB: 0,
    vramTotalMiB: 0,
    powerWatts: 0,
    pods: [],
    ...over,
  });
  it("treats application-caused XIDs as warnings, hardware ones as bad", () => {
    expect(deviceHealth(dev({ lastXid: 31 }))).toEqual({
      level: "warn",
      text: "last XID 31: GPU memory page fault (usually an application fault)",
    });
    expect(deviceHealth(dev({ lastXid: 48 })).level).toBe("bad");
    expect(deviceHealth(dev({ lastXid: 999 }))).toEqual({
      level: "bad",
      text: "last XID 999: see NVIDIA's XID catalogue",
    });
  });
  it("decodes throttle reasons; a software power cap alone is not a problem", () => {
    // 0x40 hw thermal | 0x80 power brake | 0x1 idle (ignored)
    expect(deviceHealth(dev({ throttleMask: 0xc1 }))).toEqual({
      level: "warn",
      text: "throttled: hardware thermal slowdown, throttled: hardware power brake",
    });
    // throttle state alone is not health data: no reassuring OK
    expect(deviceHealth(dev({ throttleMask: 0x4 }))).toEqual({ level: "unknown", text: "not exported" });
  });
  it("reads both DCGM names of the throttle bitmask", () => {
    const f = parsePrometheusText(
      [
        'DCGM_FI_DEV_CLOCK_THROTTLE_REASONS{gpu="0",UUID="GPU-a"} 8',
        'DCGM_FI_DEV_CLOCKS_EVENT_REASONS{gpu="1",UUID="GPU-b"} 32',
      ].join("\n"),
    );
    const d = sortDevices(aggregateDevicesDcgm(f, "n"));
    expect(d.map((x) => deviceHealth(x).text)).toEqual([
      "throttled: hardware slowdown",
      "throttled: software thermal slowdown",
    ]);
  });
});

describe("row health", () => {
  const dev = (gpu: string, over: Partial<GpuDevice> = {}): GpuDevice => ({
    node: "n",
    gpu,
    utilPct: 0,
    vramUsedMiB: 0,
    vramTotalMiB: 0,
    powerWatts: 0,
    pods: [],
    ...over,
  });
  const row = (gpus: string[]): PodGPU => ({
    namespace: "ml",
    pod: "p",
    node: "n",
    gpus,
    gpuCount: gpus.length,
    gpuUtilPct: 0,
    vramUsedMiB: 0,
    vramFreeMiB: 0,
    powerWatts: 0,
  });
  it("takes the worst GPU of a multi-GPU pod", () => {
    const devs = [dev("0", { lastXid: 0 }), dev("1", { lastXid: 79 })];
    expect(rowHealth(row(["0", "1"]), devs)?.level).toBe("bad");
    expect(rowHealth(row(["0"]), devs)).toEqual({ level: "ok", text: "OK" });
  });
  it("falls back from a MIG slice to its physical card", () => {
    const devs = [dev("3:7"), dev("3", { rowRemapFailure: 1 })];
    expect(rowHealth(row(["3:7"]), devs)).toEqual({ level: "bad", text: "row remap failed" });
  });
  it("is undefined when nothing reports health", () => {
    expect(rowHealth(row(["0:7"]), [dev("0:7")])).toBeUndefined();
  });
});
