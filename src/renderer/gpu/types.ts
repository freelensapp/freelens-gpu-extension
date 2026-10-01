/**
 * Shared data model. Mirrors kubectl-gpugo's scraper.PodGPU / Report so the
 * CLI's JSON output and this extension describe GPU usage identically.
 */

export type ExporterKind = "dcgm" | "enricher";

export interface ExporterPod {
  namespace: string;
  name: string;
  port: number;
  nodeName: string;
  kind: ExporterKind;
  /** Set when the metrics came from a Prometheus query API instead of the exporter pod itself. */
  via?: "prometheus";
}

export interface PodGPU {
  /** Which exporter the row came from: the per-process exporter splits a device per pod, DCGM does not. */
  source?: ExporterKind;
  /** Pods on this row's device (set by the store; >1 means the util/power shown are device-level). */
  sharedWith?: number;
  /**
   * The node time-slices its GPUs (nvidia.com/gpu.replicas > 1) and the row is from DCGM: other pods may share the
   * device even if the exporter only attributes it to this one, so treat the numbers as device-level.
   */
  timeSliced?: boolean;
  /** Worst health of the devices this row uses (set by the store; undefined when none reports health). */
  health?: { level: "ok" | "warn" | "bad" | "unknown"; text: string };
  namespace: string;
  pod: string;
  node: string;
  /** Set only in per-(node, GPU) fallback mode. */
  gpuIndex?: string;
  /** Candidate workloads in fallback mode ("ns/pod"). */
  hintPods?: string[];
  /** Sorted GPU indices used by this pod: "0", "1" or "0:8" (GPU 0, MIG slice 8). */
  gpus: string[];
  gpuCount: number;
  gpuUtilPct: number;
  vramUsedMiB: number;
  vramFreeMiB: number;
  powerWatts: number;
}

export type Mode = "pod" | "gpu";

/** One physical GPU, or one MIG slice when the card is partitioned. */
export interface GpuDevice {
  node: string;
  /** "0", or "0:8" for MIG slice 8 of card 0. */
  gpu: string;
  uuid?: string;
  model?: string;
  migProfile?: string;
  utilPct: number;
  vramUsedMiB: number;
  vramTotalMiB: number;
  powerWatts: number;
  tempC?: number;
  /** DCGM profiling counters as %, when DCP metrics are enabled on the exporter. */
  smActivePct?: number;
  tensorActivePct?: number;
  dramActivePct?: number;
  /** DCGM health gauges, when exported: last XID code (0 = none), uncorrectable ECC count, row remap failure/pending. */
  lastXid?: number;
  eccDbe?: number;
  rowRemapFailure?: number;
  uncorrectableRemappedRows?: number;
  /** DCGM clock event (throttle) reasons bitmask, when exported. */
  throttleMask?: number;
  /** Workload pods seen on this device ("ns/pod"). */
  pods: string[];
}

export interface ExporterScrape extends ExporterPod {
  /** Round-trip of the last scrape in ms. */
  latencyMs?: number;
  bytes?: number;
  error?: string;
}

export type { PendingGpuPod } from "./pending";

import type { PendingGpuPod } from "./pending";

/** GPU requests of pods holding devices: device count, per resource name, and the pods. */
export interface GpuRequests {
  gpus: number;
  /** Requested per resource name, e.g. { "nvidia.com/mig-1g.10gb": 3 } (includes *.shared). */
  byResource: Record<string, number>;
  pods: string[];
}

export interface Snapshot {
  scrapedAt: Date;
  mode: Mode;
  rows: PodGPU[];
  gpus: GpuDevice[];
  exporters: ExporterScrape[];
}

/**
 * What the pod list alone says, independent of any exporter: kept apart from
 * Snapshot so Pending / Namespaces / Allocation still work on a cluster whose
 * GPU exporter is missing or failing.
 */
export interface PodState {
  listedAt: Date;
  /** GPU requests of pods holding devices (Running, or Pending but already bound to a node), by node. */
  requestedByNode: Record<string, GpuRequests>;
  /** Same, grouped by namespace. */
  requestedByNamespace: Record<string, GpuRequests>;
  /** Unscheduled pods that request a GPU resource. */
  pending: PendingGpuPod[];
}

export interface HistoryPoint {
  t: number;
  utilPct: number;
  vramUsedMiB: number;
}

export interface IdleRow extends PodGPU {
  /** Minutes the pod has been observed idle (util below threshold) in this session. */
  idleMinutes: number;
  /** Number of samples backing idleMinutes. */
  samples: number;
  /** Peak utilisation over the retained history window (up to 6 h), not just the idle stretch. */
  peakUtilPct: number;
}

export interface AllocationRow {
  node: string;
  gpuType?: string;
  capacity: number;
  allocatable: number;
  /** Free MIG slices per profile (allocatable - requested); empty when the node has no MIG resources. */
  migFree?: { profile: string; free: number; total: number }[];
  /** capacity - allocatable: devices the device plugin marked unhealthy (or reserved). */
  unhealthy: number;
  requested: number;
  requestingPods: string[];
  /** Devices reporting on this node (0 if no exporter covers it). */
  devices: number;
  busyDevices: number;
  avgUtilPct: number;
  vramUsedMiB: number;
  vramTotalMiB: number;
  powerWatts: number;
}

export const isFallback = (r: PodGPU): boolean => !!r.gpuIndex;
export const vramTotalMiB = (r: PodGPU): number => r.vramUsedMiB + r.vramFreeMiB;
