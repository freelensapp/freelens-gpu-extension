import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateAmd,
  aggregateByGPU,
  aggregateByPod,
  aggregateDevicesDcgm,
  aggregateDevicesEnricher,
  buildEnricherRows,
  deviceHealth,
  extractDcgmSamples,
  gpuResourceCount,
  isIdleDevice,
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
    expect(classifyMetrics(fixture("amd_device_metrics.prom"))).toBe("amd");
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
    expect(usesGpuResource({ "amd.com/gpu": "2" })).toBe(true);
    expect(gpuResourceCount({ "amd.com/gpu": "2", cpu: "8" })).toBe(2);
    expect(usesGpuResource({ "nvidia.com/gpu": "0", cpu: "4" })).toBe(false);
    expect(usesGpuResource(undefined)).toBe(false);
  });
});

describe("AMD device metrics exporter", () => {
  const view = aggregateAmd(fams("amd_device_metrics.prom"), "n1");
  it("attributes the workload pod and keeps one device, ignoring the exporter pod and repeated gauges", () => {
    expect(view.rows).toEqual([
      expect.objectContaining({
        source: "amd",
        namespace: "dra-test",
        pod: "amd-dra-holder",
        node: "n1",
        gpus: ["0"],
        gpuCount: 1,
        gpuUtilPct: 2,
        vramUsedMiB: 2905,
        vramFreeMiB: 32768 - 2905,
        powerWatts: 22,
      }),
    ]);
    expect(view.devices).toEqual([
      expect.objectContaining({
        node: "n1",
        gpu: "0",
        uuid: "00001586-0000-1000-8000-000000000000",
        model: "AMD Radeon 8060S Graphics",
        utilPct: 2,
        vramUsedMiB: 2905,
        vramTotalMiB: 32768,
        powerWatts: 22,
        eccDbe: 0,
        pods: ["dra-test/amd-dra-holder"],
      }),
    ]);
  });
});

describe("AMD exporter on a card in CPX (MI300X: GPU 7 split into 8 partitions, gpu_id 7 to 14)", () => {
  const view = aggregateAmd(fams("amd_device_metrics_mi300x_cpx.prom"), "n1");
  const dev = (gpu: string) => view.devices.find((d) => d.gpu === gpu) as GpuDevice;

  it("lists a device per partition and puts the pod on the partitions it holds", () => {
    expect(view.devices).toHaveLength(15);
    expect(dev("12")).toMatchObject({ vramUsedMiB: 1016, vramTotalMiB: 24574, pods: ["dra-test/load-2part"] });
    expect(dev("13").pods).toEqual(["dra-test/load-2part"]);
    expect(dev("11").pods).toEqual([]);
    expect(view.rows).toEqual([
      expect.objectContaining({ pod: "load-2part", gpus: ["12", "13"], vramUsedMiB: 2032, gpuCount: 2 }),
    ]);
  });

  it("marks the partitions, and only partition 0 carries the card's utilisation and power", () => {
    expect(dev("7")).toMatchObject({ partitioned: true, utilPublished: true, powerPublished: true });
    expect(dev("12")).toMatchObject({ partitioned: true });
    expect(dev("12").utilPublished).toBeUndefined();
    expect(dev("12").powerPublished).toBeUndefined();
    expect(dev("0").partitioned).toBeUndefined();
  });

  it("has utilisation and power only on partition 0, because the exporter publishes them per card", () => {
    expect(dev("7")).toMatchObject({ utilPct: 25, powerWatts: 471 });
    expect(dev("12")).toMatchObject({ utilPct: 0, powerWatts: 0 });
    expect(dev("0")).toMatchObject({ vramTotalMiB: 196592, powerWatts: 150 });
  });

  it("gives partition 0 its partition size, not the card's VRAM, so the node total is right", () => {
    // The exporter reports 196592 MiB for gpu_id 7; its seven siblings report 24574 MiB each.
    expect(dev("7").vramTotalMiB).toBe(24574);
    const total = view.devices.reduce((sum, d) => sum + d.vramTotalMiB, 0);
    expect(Math.round(total / 1024)).toBe(7 * 192 + 8 * 24); // 7 SPX cards plus the CPX card: 1536 GiB
  });

  it("does not call a pod on partitions without a utilisation reading idle: it is unmeasured", () => {
    // load-2part holds partitions 12 and 13, and the exporter publishes utilisation and power for partition 0 only.
    const [row] = view.rows;
    expect(row).toMatchObject({ pod: "load-2part", gpuUtilPct: 0, powerWatts: 0, utilUnpublished: true });
    expect(row.powerUnpublished).toBe(true);
    expect(row.cardReading).toBeUndefined();
  });
});

describe("AMD pod rows on a split card", () => {
  // Partition 0 carries the card's reading, labelled with the pod that holds it; partition 1 has none.
  const labels = (gpu: string, part: string, pod: string) =>
    `gpu_id="${gpu}",gpu_partition_id="${part}",gpu_compute_partition_type="cpx",serial_number="S",hostname="n1",gpu_uuid="u${gpu}",namespace="ml",pod="${pod}"`;
  const text = [
    `amd_gpu_gfx_activity{${labels("0", "0", "whole")}} 40`,
    `amd_gpu_package_power{${labels("0", "0", "whole")}} 300`,
    `amd_gpu_used_vram{${labels("0", "0", "whole")}} 100`,
    `amd_gpu_used_vram{${labels("1", "1", "part")}} 500`,
  ].join("\n");
  const view = aggregateAmd(parsePrometheusText(text), "n1");

  it("marks a pod on partition 0 as showing the whole card's reading, siblings' load included", () => {
    const row = byPod(view.rows, "ml", "whole");
    expect(row).toMatchObject({ gpuUtilPct: 40, powerWatts: 300, cardReading: true });
    expect(row.utilUnpublished).toBeUndefined();
    expect(row.powerUnpublished).toBeUndefined();
  });

  it("marks a pod on another partition as unmeasured, with its VRAM kept", () => {
    expect(byPod(view.rows, "ml", "part")).toMatchObject({
      gpuUtilPct: 0,
      vramUsedMiB: 500,
      utilUnpublished: true,
      powerUnpublished: true,
    });
  });

  it("averages only over the devices that publish utilisation when a pod holds both kinds", () => {
    const both = [
      `amd_gpu_gfx_activity{${labels("0", "0", "mix")}} 40`,
      `amd_gpu_package_power{${labels("0", "0", "mix")}} 300`,
      `amd_gpu_used_vram{${labels("1", "1", "mix")}} 500`,
    ].join("\n");
    const row = byPod(aggregateAmd(parsePrometheusText(both), "n1").rows, "ml", "mix");
    expect(row.gpus).toEqual(["0", "1"]);
    expect(row.gpuUtilPct).toBe(40); // not 20: partition 1 has no reading, so it does not pull the mean down
    expect(row.utilUnpublished).toBeUndefined();
  });

  it("keeps a whole GPU's reading unflagged", () => {
    const row = aggregateAmd(fams("amd_device_metrics.prom"), "n1").rows[0];
    expect(row.utilUnpublished).toBeUndefined();
    expect(row.powerUnpublished).toBeUndefined();
    expect(row.cardReading).toBeUndefined();
  });
});

describe("AMD partitions are sized per card", () => {
  // Two cards on one node in different splits: card A in three 32 GiB partitions, card B in four 24 GiB ones. Partition
  // 0 of each reports the card's whole VRAM. Each card must keep its own partition size, not the node's.
  const gauge = (gpu: string, part: string, serial: string, total: number) =>
    `amd_gpu_total_vram{gpu_id="${gpu}",gpu_partition_id="${part}",gpu_compute_partition_type="dpx",serial_number="${serial}",hostname="n1",gpu_uuid="u${gpu}"} ${total}`;
  const text = [
    gauge("0", "0", "A", 196592),
    gauge("1", "1", "A", 32768),
    gauge("2", "2", "A", 32768),
    gauge("3", "0", "B", 196592),
    gauge("4", "1", "B", 24574),
    gauge("5", "2", "B", 24574),
    gauge("6", "3", "B", 24574),
  ].join("\n");

  it("uses the size most partitions of the same card report", () => {
    const view = aggregateAmd(parsePrometheusText(text), "n1");
    const total = (gpu: string) => view.devices.find((d) => d.gpu === gpu)?.vramTotalMiB;
    expect(total("0")).toBe(32768);
    expect(total("1")).toBe(32768);
    expect(total("3")).toBe(24574);
    expect(total("6")).toBe(24574);
  });
});

describe("isIdleDevice, the GPUs page count", () => {
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

  it("counts a whole GPU with no pod and under the threshold as idle", () => {
    expect(isIdleDevice(dev("0"), 5)).toBe(true);
  });

  it("does not count a busy device or one with a pod", () => {
    expect(isIdleDevice(dev("7", { utilPct: 25 }), 5)).toBe(false);
    expect(isIdleDevice(dev("12", { pods: ["dra-test/load-2part"] }), 5)).toBe(false);
  });

  it("does not count an AMD partition whose utilisation is not published, it reads N/A", () => {
    expect(isIdleDevice(dev("8", { partitioned: true, utilPublished: false }), 5)).toBe(false);
  });

  it("counts a partition that does publish a low utilisation", () => {
    expect(isIdleDevice(dev("0", { partitioned: true, utilPublished: true }), 5)).toBe(true);
  });
});

describe("AMD package power under either exporter name", () => {
  it("reads amd_gpu_package_power, as MI300X exports it", () => {
    const text = fixture("amd_device_metrics.prom").replaceAll(
      "amd_gpu_average_package_power",
      "amd_gpu_package_power",
    );
    const view = aggregateAmd(parsePrometheusText(text), "n1");
    expect(view.devices[0]).toMatchObject({ gpu: "0", powerWatts: 22 });
    expect(view.rows[0]).toMatchObject({ powerWatts: 22 });
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
