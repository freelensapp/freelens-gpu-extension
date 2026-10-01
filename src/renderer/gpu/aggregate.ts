/**
 * Turns parsed exporter metrics into PodGPU rows. Straight port of
 * kubectl-gpugo's internal/scraper (extractSamples, aggregateByPod,
 * aggregateByGPU, buildEnricherRows) so both tools agree on attribution.
 *
 * Three attribution paths, chosen in this order:
 *   1. per-process exporter (gpu_process_memory_bytes with pod labels)
 *   2. dcgm-exporter with pod labels (--kubernetes=true, the GPU Operator default)
 *   3. dcgm-exporter without pod labels -> per-(node, GPU) rows + candidate pods
 */

import { throttleReasons, xidInfo } from "./xid";

import type { Families, Sample } from "./prom";
import type { GpuDevice, PodGPU } from "./types";

export interface FlatSample {
  ns: string;
  pod: string;
  gpu: string;
  node: string;
  name: string;
  val: number;
}

const WANTED_DCGM = [
  "DCGM_FI_DEV_GPU_UTIL",
  "DCGM_FI_DEV_FB_USED",
  "DCGM_FI_DEV_FB_FREE",
  "DCGM_FI_DEV_POWER_USAGE",
  // per-MIG-slice graphics engine activity ratio [0,1]; MIG installs disable
  // DCGM_FI_DEV_GPU_UTIL entirely, so this stands in as util on MIG.
  "DCGM_FI_PROF_GR_ENGINE_ACTIVE",
];

// Profiling ratios [0,1]: what the SMs / tensor cores / memory interface actually do. GPU_UTIL only says a kernel
// was running, so a card can show 100% while doing little; these counters are off unless DCP metrics are enabled.
const PROF_DCGM = ["DCGM_FI_PROF_SM_ACTIVE", "DCGM_FI_PROF_PIPE_TENSOR_ACTIVE", "DCGM_FI_PROF_DRAM_ACTIVE"];

// Health gauges. XID_ERRORS is the code of the last XID seen (0 = none); the others count errors / rows.
// dcgm-exporter reports remap fields for whole GPUs only (not per MIG slice).
const HEALTH_DCGM = [
  "DCGM_FI_DEV_XID_ERRORS",
  "DCGM_FI_DEV_ECC_DBE_VOL_TOTAL",
  "DCGM_FI_DEV_ROW_REMAP_FAILURE",
  "DCGM_FI_DEV_UNCORRECTABLE_REMAPPED_ROWS",
  // clock event (throttle) reasons bitmask; renamed in newer DCGM, both are read
  "DCGM_FI_DEV_CLOCK_THROTTLE_REASONS",
  "DCGM_FI_DEV_CLOCKS_EVENT_REASONS",
];

const DEVICE_DCGM = [...WANTED_DCGM, "DCGM_FI_DEV_GPU_TEMP", "DCGM_FI_DEV_FB_TOTAL", ...PROF_DCGM, ...HEALTH_DCGM];

/** Every metric family the extension reads, per exporter kind (the Prometheus fallback queries exactly these). */
export const DCGM_METRICS: readonly string[] = DEVICE_DCGM;
export const ENRICHER_METRICS: readonly string[] = [
  "gpu_process_memory_bytes",
  "gpu_process_utilization_percent",
  "gpu_total_memory_bytes",
  "gpu_total_utilization_percent",
  "gpu_power_usage_watts",
  "gpu_temperature_celsius",
];

/** DCGM: flatten wanted families into (ns, pod, gpu, node, metric, value). */
export function extractDcgmSamples(fams: Families, exporterNode: string): FlatSample[] {
  const out: FlatSample[] = [];
  for (const name of WANTED_DCGM) {
    for (const m of fams.get(name) ?? []) {
      const l = m.labels;
      const ns = l.namespace || l.exported_namespace || "";
      const pod = l.pod || l.exported_pod || "";
      let gpu = l.gpu || l.device || l.UUID || "";
      // MIG: `gpu` is the physical card, GPU_I_ID the slice. Key on both or
      // several pods sharing card 0 collapse into one row.
      if (l.GPU_I_ID) gpu = `${gpu}:${l.GPU_I_ID}`;
      // The exporter pod's spec.nodeName is authoritative; DCGM's Hostname is
      // the container hostname (= exporter pod name) unless NODE_NAME is set.
      const node = exporterNode || l.Hostname || "";
      out.push({ ns, pod, gpu, node, name, val: m.value });
    }
  }
  return out;
}

interface Acc {
  row: PodGPU;
  seenGPU: Set<string>;
  /**
   * Util per GPU, kept per source: non-MIG cards with profiling enabled emit
   * BOTH GPU_UTIL and PROF_GR_ENGINE_ACTIVE, so summing them double-counts.
   * GPU_UTIL wins when present; GR_ENGINE_ACTIVE covers MIG slices.
   */
  util: Map<string, { dev?: number; prof?: number }>;
}

function utilOf(acc: Acc, gpu: string) {
  let u = acc.util.get(gpu);
  if (!u) {
    u = {};
    acc.util.set(gpu, u);
  }
  return u;
}

function apply(acc: Acc, metric: string, gpu: string, v: number) {
  // Count the (pod, gpu) pair regardless of which metric brought us here:
  // MIG installs never emit DCGM_FI_DEV_GPU_UTIL.
  if (!acc.seenGPU.has(gpu)) {
    acc.seenGPU.add(gpu);
    acc.row.gpuCount++;
    if (gpu !== "") acc.row.gpus.push(gpu);
  }
  switch (metric) {
    case "DCGM_FI_DEV_GPU_UTIL":
      utilOf(acc, gpu).dev = v;
      break;
    case "DCGM_FI_PROF_GR_ENGINE_ACTIVE":
      utilOf(acc, gpu).prof = v * 100; // ratio -> percent, to match GPU_UTIL semantics
      break;
    case "DCGM_FI_DEV_FB_USED":
      acc.row.vramUsedMiB += v;
      break;
    case "DCGM_FI_DEV_FB_FREE":
      acc.row.vramFreeMiB += v;
      break;
    case "DCGM_FI_DEV_POWER_USAGE":
      acc.row.powerWatts += v;
      break;
  }
}

function finalize(accs: Map<string, Acc>): PodGPU[] {
  const out: PodGPU[] = [];
  for (const acc of accs.values()) {
    let utilSum = 0;
    for (const u of acc.util.values()) utilSum += u.dev ?? u.prof ?? 0;
    if (acc.row.gpuCount > 0) acc.row.gpuUtilPct = utilSum / acc.row.gpuCount;
    acc.row.gpus.sort();
    out.push(acc.row);
  }
  return out;
}

function newRow(partial: Partial<PodGPU> & Pick<PodGPU, "namespace" | "pod" | "node">): PodGPU {
  return {
    gpus: [],
    gpuCount: 0,
    gpuUtilPct: 0,
    vramUsedMiB: 0,
    vramFreeMiB: 0,
    powerWatts: 0,
    ...partial,
  };
}

/** DCGM path 2: one row per workload pod (samples without pod labels are dropped). */
export function aggregateByPod(samples: FlatSample[]): PodGPU[] {
  const accs = new Map<string, Acc>();
  for (const s of samples) {
    if (!s.ns || !s.pod) continue;
    const key = `${s.ns}/${s.pod}`;
    let acc = accs.get(key);
    if (!acc) {
      acc = {
        row: newRow({ namespace: s.ns, pod: s.pod, node: s.node, source: "dcgm" }),
        seenGPU: new Set(),
        util: new Map(),
      };
      accs.set(key, acc);
    } else if (!acc.row.node) {
      acc.row.node = s.node;
    }
    apply(acc, s.name, s.gpu, s.val);
  }
  return finalize(accs);
}

/** DCGM path 3: one row per (node, GPU). Caller attaches hintPods. */
export function aggregateByGPU(samples: FlatSample[]): PodGPU[] {
  const accs = new Map<string, Acc>();
  for (const s of samples) {
    const gpu = s.gpu || "?";
    const key = `${s.node}/${gpu}`;
    let acc = accs.get(key);
    if (!acc) {
      acc = {
        row: newRow({ namespace: "-", pod: `(gpu ${gpu})`, node: s.node, gpuIndex: gpu, gpus: [gpu], gpuCount: 1 }),
        seenGPU: new Set([gpu]),
        util: new Map(),
      };
      accs.set(key, acc);
    }
    apply(acc, s.name, gpu, s.val);
  }
  return finalize(accs);
}

export interface EnricherResult {
  fams: Families;
  node: string;
}

const MIB = 1024 * 1024;

/**
 * Path 1: per-process exporter. Sums process VRAM per (pod, GPU uuid), takes
 * max util across a pod's processes, and splits each GPU's total power across
 * its pods proportionally to VRAM share.
 */
export function buildEnricherRows(results: EnricherResult[]): PodGPU[] {
  interface GpuInfo {
    totalVRAM: number;
    powerW: number;
  }
  interface Use {
    node: string;
    gpuIdx: string;
    vramBytes: number;
    utilPct: number;
  }
  const gpus = new Map<string, GpuInfo>(); // uuid
  const pods = new Map<string, Map<string, Use>>(); // ns/pod -> uuid -> use

  const useFor = (m: Sample, node: string): Use | undefined => {
    const { namespace: ns, pod, uuid, gpu = "" } = m.labels;
    if (!ns || !pod || !uuid) return undefined;
    const key = `${ns}/${pod}`;
    let byUuid = pods.get(key);
    if (!byUuid) {
      byUuid = new Map();
      pods.set(key, byUuid);
    }
    let use = byUuid.get(uuid);
    if (!use) {
      use = { node, gpuIdx: gpu, vramBytes: 0, utilPct: 0 };
      byUuid.set(uuid, use);
    } else if (!use.gpuIdx) {
      use.gpuIdx = gpu;
    }
    return use;
  };
  const gpuFor = (m: Sample): GpuInfo | undefined => {
    const { uuid } = m.labels;
    if (!uuid) return undefined;
    let g = gpus.get(uuid);
    if (!g) {
      g = { totalVRAM: 0, powerW: 0 };
      gpus.set(uuid, g);
    }
    return g;
  };

  for (const r of results) {
    for (const m of r.fams.get("gpu_process_memory_bytes") ?? []) {
      const u = useFor(m, r.node);
      if (u) u.vramBytes += m.value;
    }
    for (const m of r.fams.get("gpu_process_utilization_percent") ?? []) {
      const u = useFor(m, r.node);
      if (u && m.value > u.utilPct) u.utilPct = m.value;
    }
    for (const m of r.fams.get("gpu_total_memory_bytes") ?? []) {
      const g = gpuFor(m);
      if (g) g.totalVRAM = m.value;
    }
    for (const m of r.fams.get("gpu_power_usage_watts") ?? []) {
      const g = gpuFor(m);
      if (g) g.powerW = m.value;
    }
  }

  const rows: PodGPU[] = [];
  for (const [nsPod, uses] of pods) {
    const i = nsPod.indexOf("/");
    const ns = nsPod.slice(0, i);
    const pod = nsPod.slice(i + 1);
    let totalUsed = 0;
    let totalGPU = 0;
    let power = 0;
    let maxUtil = 0;
    let node = "";
    const gpuIdxs: string[] = [];
    for (const [uuid, use] of uses) {
      totalUsed += use.vramBytes;
      maxUtil = Math.max(maxUtil, use.utilPct);
      if (!node) node = use.node;
      if (use.gpuIdx) gpuIdxs.push(use.gpuIdx);
      const g = gpus.get(uuid);
      if (g) {
        totalGPU += g.totalVRAM;
        if (g.totalVRAM > 0) power += g.powerW * (use.vramBytes / g.totalVRAM);
      }
    }
    gpuIdxs.sort();
    rows.push({
      source: "enricher",
      namespace: ns,
      pod,
      node,
      gpus: gpuIdxs,
      gpuCount: uses.size,
      gpuUtilPct: maxUtil,
      vramUsedMiB: totalUsed / MIB,
      vramFreeMiB: (totalGPU - totalUsed) / MIB,
      powerWatts: power,
    });
  }
  return rows;
}

/**
 * Sort key: zero-padded GPU index components so "0:8" < "0:10" and rows on
 * the same card / slice cluster together. Same rule as kubectl-gpugo.
 */
export function gpuSortKey(r: PodGPU): string {
  if (r.gpus.length === 0) return "~";
  return r.gpus
    .map((g) =>
      g
        .split(":")
        .map((p) => p.padStart(3, "0"))
        .join(":"),
    )
    .join(",");
}

/** Display order: by GPU, then VRAM used desc, then namespace/pod. */
export function sortRows(rows: PodGPU[]): PodGPU[] {
  return [...rows].sort((a, b) => {
    const ka = gpuSortKey(a);
    const kb = gpuSortKey(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    if (a.vramUsedMiB !== b.vramUsedMiB) return b.vramUsedMiB - a.vramUsedMiB;
    if (a.namespace !== b.namespace) return a.namespace < b.namespace ? -1 : 1;
    return a.pod < b.pod ? -1 : a.pod > b.pod ? 1 : 0;
  });
}

/** Physical card grouping for visual separators: "0:8" -> "0". */
export function physicalGPUGroup(r: PodGPU): string {
  if (r.gpus.length === 0) return "";
  const first = r.gpus[0];
  const i = first.indexOf(":");
  return i >= 0 ? first.slice(0, i) : r.gpus.join(",");
}

// ---------------------------------------------------------------------------
// Per-device view (one row per physical GPU / MIG slice)
// ---------------------------------------------------------------------------

interface DevAcc {
  dev: GpuDevice;
  /** Max PROF_GR_ENGINE_ACTIVE (as %), used only when GPU_UTIL is absent. */
  profUtil?: number;
  hasDevUtil?: boolean;
  fbTotal?: number;
  pods: Set<string>;
}

function devKey(node: string, gpu: string) {
  return `${node}/${gpu}`;
}

function newDev(node: string, gpu: string): DevAcc {
  return {
    dev: { node, gpu, utilPct: 0, vramUsedMiB: 0, vramTotalMiB: 0, powerWatts: 0, pods: [] },
    pods: new Set(),
  };
}

/**
 * DCGM: every metric line is already per device (per slice on MIG), and the
 * same device appears once per attributed pod when several pods share it.
 * Take gauges as-is (not summed) and collect the pod set.
 */
export function aggregateDevicesDcgm(fams: Families, exporterNode: string): GpuDevice[] {
  const accs = new Map<string, DevAcc>();
  for (const name of DEVICE_DCGM) {
    for (const m of fams.get(name) ?? []) {
      const l = m.labels;
      let gpu = l.gpu || l.device || l.UUID || "?";
      if (l.GPU_I_ID) gpu = `${gpu}:${l.GPU_I_ID}`;
      // The exporter pod's spec.nodeName is authoritative; DCGM's Hostname is
      // the container hostname (= exporter pod name) unless NODE_NAME is set.
      const node = exporterNode || l.Hostname || "";
      const k = devKey(node, gpu);
      let acc = accs.get(k);
      if (!acc) {
        acc = newDev(node, gpu);
        accs.set(k, acc);
      }
      const d = acc.dev;
      if (l.UUID && !d.uuid) d.uuid = l.UUID;
      if (l.modelName && !d.model) d.model = l.modelName;
      if (l.GPU_I_PROFILE && !d.migProfile) d.migProfile = l.GPU_I_PROFILE;
      const ns = l.namespace || l.exported_namespace;
      const pod = l.pod || l.exported_pod;
      if (ns && pod) acc.pods.add(`${ns}/${pod}`);
      // Gauges repeat per pod label set; keep the max rather than summing.
      switch (name) {
        case "DCGM_FI_DEV_GPU_UTIL":
          d.utilPct = acc.hasDevUtil ? Math.max(d.utilPct, m.value) : m.value;
          acc.hasDevUtil = true;
          break;
        case "DCGM_FI_PROF_GR_ENGINE_ACTIVE":
          acc.profUtil = Math.max(acc.profUtil ?? 0, m.value * 100);
          break;
        case "DCGM_FI_DEV_FB_USED":
          d.vramUsedMiB = Math.max(d.vramUsedMiB, m.value);
          break;
        case "DCGM_FI_DEV_FB_FREE":
          acc.fbTotal = Math.max(acc.fbTotal ?? 0, m.value); // temporarily holds FREE
          break;
        case "DCGM_FI_DEV_FB_TOTAL":
          d.vramTotalMiB = Math.max(d.vramTotalMiB, m.value);
          break;
        case "DCGM_FI_DEV_POWER_USAGE":
          d.powerWatts = Math.max(d.powerWatts, m.value);
          break;
        case "DCGM_FI_DEV_GPU_TEMP":
          d.tempC = Math.max(d.tempC ?? 0, m.value);
          break;
        case "DCGM_FI_PROF_SM_ACTIVE":
          d.smActivePct = Math.max(d.smActivePct ?? 0, m.value * 100);
          break;
        case "DCGM_FI_PROF_PIPE_TENSOR_ACTIVE":
          d.tensorActivePct = Math.max(d.tensorActivePct ?? 0, m.value * 100);
          break;
        case "DCGM_FI_PROF_DRAM_ACTIVE":
          d.dramActivePct = Math.max(d.dramActivePct ?? 0, m.value * 100);
          break;
        case "DCGM_FI_DEV_XID_ERRORS":
          d.lastXid = Math.max(d.lastXid ?? 0, m.value);
          break;
        case "DCGM_FI_DEV_ECC_DBE_VOL_TOTAL":
          d.eccDbe = Math.max(d.eccDbe ?? 0, m.value);
          break;
        case "DCGM_FI_DEV_ROW_REMAP_FAILURE":
          d.rowRemapFailure = Math.max(d.rowRemapFailure ?? 0, m.value);
          break;
        case "DCGM_FI_DEV_UNCORRECTABLE_REMAPPED_ROWS":
          d.uncorrectableRemappedRows = Math.max(d.uncorrectableRemappedRows ?? 0, m.value);
          break;
        case "DCGM_FI_DEV_CLOCK_THROTTLE_REASONS":
        case "DCGM_FI_DEV_CLOCKS_EVENT_REASONS":
          d.throttleMask = (d.throttleMask ?? 0) | Math.trunc(m.value);
          break;
      }
    }
  }
  const out: GpuDevice[] = [];
  for (const acc of accs.values()) {
    if (!acc.hasDevUtil && acc.profUtil !== undefined) acc.dev.utilPct = acc.profUtil;
    if (acc.dev.vramTotalMiB === 0) acc.dev.vramTotalMiB = acc.dev.vramUsedMiB + (acc.fbTotal ?? 0);
    acc.dev.pods = [...acc.pods].sort();
    out.push(acc.dev);
  }
  return out;
}

/**
 * Per-process exporter: device totals come from gpu_total_* / gpu_power_*
 * (per uuid), usage is the sum of process memory, util is the device-level
 * gauge when present, else the max process util.
 */
export function aggregateDevicesEnricher(results: EnricherResult[]): GpuDevice[] {
  const byUuid = new Map<string, DevAcc & { procUtilMax: number; hasTotalUtil: boolean }>();
  const get = (uuid: string, node: string, gpu: string, model?: string) => {
    let a = byUuid.get(uuid);
    if (!a) {
      a = { ...newDev(node, gpu || "?"), procUtilMax: 0, hasTotalUtil: false };
      a.dev.uuid = uuid;
      byUuid.set(uuid, a);
    }
    if (model && !a.dev.model) a.dev.model = model;
    if (a.dev.gpu === "?" && gpu) a.dev.gpu = gpu;
    return a;
  };
  const MIB = 1024 * 1024;
  for (const r of results) {
    for (const m of r.fams.get("gpu_process_memory_bytes") ?? []) {
      const { uuid, gpu = "", model, namespace, pod } = m.labels;
      if (!uuid) continue;
      const a = get(uuid, r.node, gpu, model);
      a.dev.vramUsedMiB += m.value / MIB;
      if (namespace && pod) a.pods.add(`${namespace}/${pod}`);
    }
    for (const m of r.fams.get("gpu_process_utilization_percent") ?? []) {
      const { uuid, gpu = "", model } = m.labels;
      if (!uuid) continue;
      const a = get(uuid, r.node, gpu, model);
      a.procUtilMax = Math.max(a.procUtilMax, m.value);
    }
    for (const m of r.fams.get("gpu_total_memory_bytes") ?? []) {
      const { uuid, gpu = "", model } = m.labels;
      if (!uuid) continue;
      get(uuid, r.node, gpu, model).dev.vramTotalMiB = m.value / MIB;
    }
    for (const m of r.fams.get("gpu_total_utilization_percent") ?? []) {
      const { uuid, gpu = "", model } = m.labels;
      if (!uuid) continue;
      const a = get(uuid, r.node, gpu, model);
      a.dev.utilPct = m.value;
      a.hasTotalUtil = true;
    }
    for (const m of r.fams.get("gpu_power_usage_watts") ?? []) {
      const { uuid, gpu = "", model } = m.labels;
      if (!uuid) continue;
      get(uuid, r.node, gpu, model).dev.powerWatts = m.value;
    }
    for (const m of r.fams.get("gpu_temperature_celsius") ?? []) {
      const { uuid, gpu = "", model } = m.labels;
      if (!uuid) continue;
      get(uuid, r.node, gpu, model).dev.tempC = m.value;
    }
  }
  const out: GpuDevice[] = [];
  for (const a of byUuid.values()) {
    if (!a.hasTotalUtil) a.dev.utilPct = a.procUtilMax;
    a.dev.pods = [...a.pods].sort();
    out.push(a.dev);
  }
  return out;
}

/** nvidia.com/gpu, its renamed variants (nvidia.com/gpu.shared) and MIG resources (nvidia.com/mig-*). */
export const isGpuResourceName = (k: string): boolean =>
  k === "nvidia.com/gpu" || k.startsWith("nvidia.com/gpu.") || k.startsWith("nvidia.com/mig-");
const isShared = (k: string) => k.endsWith(".shared");

export type HealthLevel = "ok" | "warn" | "bad" | "unknown";

/**
 * One device's health from the DCGM health gauges. "unknown" when the exporter
 * reports none of them for this device (e.g. MIG slices, or counters not in the
 * exporter's CSV) — never a reassuring "ok" without data.
 */
export function deviceHealth(d: GpuDevice): { level: HealthLevel; text: string } {
  const issues: string[] = [];
  let level: HealthLevel = "ok";
  if ((d.lastXid ?? 0) > 0) {
    const x = xidInfo(d.lastXid as number);
    // DCGM keeps the code of the LAST XID seen; it can be long past, so say so.
    issues.push(`last XID ${d.lastXid}: ${x.meaning}`);
    // Application-caused XIDs (13, 31, 43, 45) are the workload's fault; the GPU itself is usually fine.
    if (x.application) {
      if (level === "ok") level = "warn";
    } else level = "bad";
  }
  if ((d.eccDbe ?? 0) > 0) {
    issues.push(`${d.eccDbe} uncorrectable ECC`);
    level = "bad";
  }
  if ((d.rowRemapFailure ?? 0) > 0) {
    issues.push("row remap failed");
    level = "bad";
  }
  if ((d.uncorrectableRemappedRows ?? 0) > 0) {
    issues.push(`${d.uncorrectableRemappedRows} rows remapped (reset pending)`);
    if (level === "ok") level = "warn";
  }
  for (const t of throttleReasons(d.throttleMask ?? 0)) {
    if (!t.serious) continue; // a software power cap is configuration, not a problem
    issues.push(`throttled: ${t.label}`);
    if (level === "ok") level = "warn";
  }
  if (issues.length > 0) return { level, text: issues.join(", ") };
  // Throttle state is not hardware health: a device exporting only the throttle bitmask stays "not exported".
  const known = [d.lastXid, d.eccDbe, d.rowRemapFailure, d.uncorrectableRemappedRows].some((v) => v !== undefined);
  return known ? { level: "ok", text: "OK" } : { level: "unknown", text: "not exported" };
}

/**
 * A node's health: its worst device, and bad whenever the device plugin has withdrawn devices
 * (capacity > allocatable) — that alone means hardware trouble even when no health gauge is exported.
 */
export function nodeHealth(devs: GpuDevice[], withdrawn = 0): { level: HealthLevel; text: string } {
  const per = devs.map((d) => ({ d, h: deviceHealth(d) }));
  const bad = per.filter((x) => x.h.level === "bad");
  const warn = per.filter((x) => x.h.level === "warn");
  const parts: string[] = [];
  if (withdrawn > 0) parts.push(`${withdrawn} withdrawn`);
  for (const { d, h } of [...bad, ...warn]) parts.push(`GPU ${d.gpu} ${h.text}`);
  if (withdrawn > 0 || bad.length > 0) return { level: "bad", text: parts.join(", ") };
  if (warn.length > 0) return { level: "warn", text: parts.join(", ") };
  const reporting = per.filter((x) => x.h.level === "ok").length;
  if (reporting === 0) return { level: "unknown", text: "not exported" };
  return { level: "ok", text: reporting === devs.length ? "OK" : `OK (${reporting} of ${devs.length} report)` };
}

/**
 * Health of the devices a pod row uses: the worst of its GPUs (a MIG slice falls back to its physical card, which is
 * where hardware gauges live). Undefined when none of them reports health.
 */
export function rowHealth(r: PodGPU, devs: GpuDevice[]): { level: HealthLevel; text: string } | undefined {
  const byKey = new Map(devs.map((d) => [`${d.node}/${d.gpu}`, d]));
  const rank = { bad: 0, warn: 1, ok: 2, unknown: 3 } as const;
  let worst: { level: HealthLevel; text: string } | undefined;
  for (const g of r.gpus) {
    const d = byKey.get(`${r.node}/${g}`);
    let h = d ? deviceHealth(d) : undefined;
    if ((!h || h.level === "unknown") && g.includes(":")) {
      const card = byKey.get(`${r.node}/${g.split(":")[0]}`);
      if (card) h = deviceHealth(card);
    }
    if (h && h.level !== "unknown" && (!worst || rank[h.level] < rank[worst.level])) worst = h;
  }
  return worst;
}

/**
 * How many workload pods share each device, keyed "node/gpu". A pod row whose
 * GPU is shared carries device-level numbers (dcgm-exporter reports the whole
 * device's util/power on every pod that uses it), not that pod's share.
 */
export function podsPerDevice(devs: GpuDevice[]): Map<string, number> {
  return new Map(devs.map((d) => [`${d.node}/${d.gpu}`, d.pods.length]));
}

/** Number of pods the exporter attributes to the busiest device of a DCGM pod row (1 = not shared). */
export function sharedWith(r: PodGPU, perDevice: Map<string, number>): number {
  if (r.source !== "dcgm" || r.gpuIndex) return 1;
  let n = 1;
  for (const g of r.gpus) n = Math.max(n, perDevice.get(`${r.node}/${g}`) ?? 1);
  return n;
}

/** Compute size of a MIG profile: "3g.40gb" -> 3 (GPU instances are sized in compute slices). */
const migComputeSlices = (profile?: string): number => {
  const m = /^(\d+)g\./.exec(profile ?? "");
  return m ? Number(m[1]) : 1;
};

/**
 * Power per device for attribution to pods. A MIG slice reports its whole card's DCGM_FI_DEV_POWER_USAGE, so giving
 * each slice (and so each pod on one) the full draw multiplies a card by its slice count when summed per pod or per
 * namespace. Each slice gets the card's power weighted by its compute size among the card's slices (1g of a fully
 * partitioned A100 = 1/7); whole GPUs keep their own power. Keyed "node/gpu".
 */
export function devicePowerShares(devs: GpuDevice[]): Map<string, number> {
  const out = new Map<string, number>();
  const cards = new Map<string, GpuDevice[]>();
  for (const d of devs) {
    if (!d.gpu.includes(":")) {
      out.set(`${d.node}/${d.gpu}`, d.powerWatts);
      continue;
    }
    const card = `${d.node}/${d.uuid ?? d.gpu.split(":")[0]}`;
    cards.set(card, [...(cards.get(card) ?? []), d]);
  }
  for (const slices of cards.values()) {
    const cardPower = Math.max(...slices.map((d) => d.powerWatts));
    const total = slices.reduce((s, d) => s + migComputeSlices(d.migProfile), 0);
    for (const d of slices) out.set(`${d.node}/${d.gpu}`, (cardPower * migComputeSlices(d.migProfile)) / total);
  }
  return out;
}

/**
 * A DCGM pod row's power as its share of the devices it uses (see devicePowerShares). Rows from the per-process
 * exporter are already split by VRAM share and are returned unchanged, as are rows whose devices are unknown.
 */
export function attributedPower(r: PodGPU, shares: Map<string, number>): number {
  if (r.source !== "dcgm" || r.gpus.length === 0) return r.powerWatts;
  let sum = 0;
  for (const g of r.gpus) {
    const w = shares.get(`${r.node}/${g}`);
    if (w === undefined) return r.powerWatts;
    sum += w;
  }
  return sum;
}

/**
 * GPU devices in a resource list: `nvidia.com/gpu` plus every MIG resource
 * (`nvidia.com/mig-1g.10gb`, ...) that the device plugin advertises under
 * mig.strategy=mixed. Units are devices (whole GPUs or slices), matching
 * what the exporters report per row. `*.shared` resources (time-slicing
 * replicas, renameByDefault) are replicas of those same devices, not extra
 * hardware, so they are not counted.
 */
export function gpuResourceCount(resources: Record<string, string> | undefined): number {
  let n = 0;
  for (const [k, v] of Object.entries(resources ?? {})) {
    if (isGpuResourceName(k) && !isShared(k)) n += Number(v) || 0;
  }
  return n;
}

/** Whether a resource list asks for any GPU at all, including time-sliced `*.shared` replicas. */
export function usesGpuResource(resources: Record<string, string> | undefined): boolean {
  return Object.entries(resources ?? {}).some(([k, v]) => isGpuResourceName(k) && (Number(v) || 0) > 0);
}

/**
 * Total power over devices, counted once per physical card. On MIG every
 * slice repeats its card's DCGM_FI_DEV_POWER_USAGE, so a plain sum
 * multiplies a 7-slice A100's draw by 7.
 */
export function totalPowerW(devs: GpuDevice[]): number {
  const byCard = new Map<string, number>();
  for (const d of devs) {
    const card = `${d.node}/${d.uuid ?? d.gpu.split(":")[0]}`;
    byCard.set(card, Math.max(byCard.get(card) ?? 0, d.powerWatts));
  }
  let sum = 0;
  for (const w of byCard.values()) sum += w;
  return sum;
}

/** Display order for devices: node, then GPU index (MIG slices under their card). */
export function sortDevices(devs: GpuDevice[]): GpuDevice[] {
  const key = (d: GpuDevice) =>
    d.gpu
      .split(":")
      .map((p) => p.padStart(3, "0"))
      .join(":");
  return [...devs].sort((a, b) => {
    if (a.node !== b.node) return a.node < b.node ? -1 : 1;
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
