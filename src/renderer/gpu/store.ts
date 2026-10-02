/**
 * MobX store holding the latest GPU snapshot for the active cluster frame,
 * a rolling in-memory history (for the idle/waste view), and the node
 * allocation view (nvidia.com/gpu capacity vs requested vs measured).
 * One instance per cluster frame.
 */

import { Renderer } from "@freelensapp/extensions";
import { action, computed, makeObservable, observable, runInAction } from "mobx";
import {
  attributedPower,
  devicePowerShares,
  gpuResourceCount,
  isGpuResourceName,
  podsPerDevice,
  rowHealth,
  sharedWith,
  sortDevices,
  sortRows,
  totalPowerW,
} from "./aggregate";
import { type InferenceLevel, inferenceStatus, type VllmRates, type VllmSample, vllmRates } from "./inference";
import { aggregateNamespaces, migFree, type NamespaceRow } from "./namespaces";
import { explainPending, type NodeGpuResources, type PendingGpuPod } from "./pending";
import { DISCOVERY_TTL_MS, GpuScraper, type InferenceScrape, type ProbeResult } from "./scraper";
import { formatTarget, isTarget, parseTarget, type Target } from "./targets";

import type { ReportInput } from "./report";
import type { AllocationRow, GpuDevice, HistoryPoint, IdleRow, PodGPU, PodState, Snapshot } from "./types";

export const DEFAULT_INTERVAL_MS = 20_000;
const STALE_MS = 30_000;
const HISTORY_MS = 6 * 60 * 60_000; // keep up to 6h of samples per pod
export const IDLE_UTIL_PCT = 5;
export const IDLE_MIN_VRAM_MIB = 256;

interface NodeInfo {
  name: string;
  gpuType?: string;
  capacity: number;
  allocatable: number;
  /** Allocatable GPU resources by name (nvidia.com/gpu, nvidia.com/mig-1g.10gb, ...), for pending-pod hints. */
  gpuResources: Record<string, number>;
  /** GPU Operator time-slicing replicas (label nvidia.com/gpu.replicas); >1 means devices are shared. */
  replicas: number;
}

export interface InferenceRow extends InferenceScrape {
  rates: VllmRates;
  status: { level: InferenceLevel; text: string };
  /** The GPU row of the same pod, when an exporter attributes one. */
  gpu?: PodGPU;
}

export interface PendingRow extends PendingGpuPod {
  hints: string[];
}

export class GpuStore {
  @observable.ref snapshot: Snapshot | undefined = undefined;
  /** Pinned exporter / Prometheus targets for the active cluster (persisted per cluster in localStorage). */
  @observable.ref pins: Target[] = [];
  private pinsLoadedFor: string | undefined;
  /** Inference servers (vLLM) scraped on every refresh, with rates against the previous scrape. */
  @observable.ref inference: { scrape: InferenceScrape; rates: VllmRates }[] = [];
  private inferencePrev = new Map<string, { at: number; sample: VllmSample }>();
  /** Pod-list state; updated even when the metrics snapshot fails (no exporter, scrape errors). */
  @observable.ref podState: PodState | undefined = undefined;
  @observable error: string | undefined = undefined;
  @observable loading = false;
  @observable.ref nodes: NodeInfo[] = [];
  @observable nodesError: string | undefined = undefined;
  /** When the node list was last requested; nodes change rarely, so they follow the discovery cadence. */
  private nodesLoadedAt = 0;
  /** Rolling per-pod history, keyed "ns/pod". Bumped via historyVersion for observers. */
  readonly history = new Map<string, HistoryPoint[]>();
  @observable historyVersion = 0;

  private timer: ReturnType<typeof setInterval> | undefined;
  private inflight: Promise<void> | undefined;
  private subscribers = 0;

  constructor(readonly scraper = new GpuScraper()) {
    makeObservable(this);
  }

  @computed get rows(): PodGPU[] {
    if (!this.snapshot) return [];
    const perDevice = podsPerDevice(this.snapshot.gpus);
    const powerShares = devicePowerShares(this.snapshot.gpus);
    const replicas = new Map(this.nodes.map((n) => [n.name, n.replicas]));
    return sortRows(this.snapshot.rows).map((r) => ({
      ...r,
      powerWatts: attributedPower(r, powerShares),
      sharedWith: sharedWith(r, perDevice),
      timeSliced: r.source === "dcgm" && !r.gpuIndex && (replicas.get(r.node) ?? 1) > 1,
      health: rowHealth(r, this.snapshot?.gpus ?? []),
    }));
  }

  @computed get devices(): GpuDevice[] {
    return this.snapshot ? sortDevices(this.snapshot.gpus) : [];
  }

  /**
   * The cluster is known to have GPUs: an exporter answered, or a node advertises a GPU resource. The Pod drawer
   * polls for any pod only then, so opening pods on a cluster without GPUs does not start the scrape loop.
   */
  @computed get hasGpus(): boolean {
    return (this.snapshot?.exporters.length ?? 0) > 0 || this.nodes.some((n) => n.capacity > 0 || n.allocatable > 0);
  }

  get probes(): ProbeResult[] {
    return this.scraper.lastProbes;
  }

  rowsForPod(namespace: string, name: string): PodGPU[] {
    return this.rows.filter(
      (r) => (r.namespace === namespace && r.pod === name) || r.hintPods?.includes(`${namespace}/${name}`),
    );
  }

  rowsForNode(node: string): PodGPU[] {
    return this.rows.filter((r) => r.node === node);
  }

  devicesForNode(node: string): GpuDevice[] {
    return this.devices.filter((d) => d.node === node);
  }

  /** Pods currently holding VRAM at (near) zero utilisation, with how long we have seen them idle. */
  @computed get idleRows(): IdleRow[] {
    void this.historyVersion; // subscribe to history updates
    const out: IdleRow[] = [];
    for (const r of this.rows) {
      if (r.gpuIndex) continue; // fallback rows have no pod identity
      if (r.gpuUtilPct >= IDLE_UTIL_PCT || r.vramUsedMiB < IDLE_MIN_VRAM_MIB) continue;
      const h = this.history.get(`${r.namespace}/${r.pod}`) ?? [];
      // walk back from the newest sample while util stays below threshold
      let i = h.length - 1;
      while (i >= 0 && h[i].utilPct < IDLE_UTIL_PCT) i--;
      // peak over the whole retained window, so a pod that was busy earlier stands out
      const peak = h.reduce((m, p) => Math.max(m, p.utilPct), r.gpuUtilPct);
      const idleSince = h[i + 1]?.t ?? Date.now();
      const samples = h.length - 1 - i;
      out.push({
        ...r,
        idleMinutes: Math.max(0, (Date.now() - idleSince) / 60_000),
        samples,
        peakUtilPct: peak,
      });
    }
    return out.sort((a, b) => b.vramUsedMiB - a.vramUsedMiB);
  }

  /** Per namespace: requested vs in use vs idle vs waiting ("whose GPUs are these?"). */
  @computed get namespaceRows(): NamespaceRow[] {
    const ps = this.podState;
    if (!ps) return [];
    return aggregateNamespaces(ps.requestedByNamespace, this.rows, this.idleRows, ps.pending);
  }

  /** Inference servers joined with their GPU rows; worst status first. */
  @computed get inferenceRows(): InferenceRow[] {
    const gpuByPod = new Map(this.rows.map((r) => [`${r.namespace}/${r.pod}`, r]));
    const rank = { bad: 0, warn: 1, ok: 2, idle: 3 } as const;
    return this.inference
      .map(({ scrape, rates }) => ({
        ...scrape,
        rates,
        status: scrape.sample
          ? inferenceStatus(scrape.sample, rates)
          : { level: "warn" as const, text: `metrics unreachable: ${scrape.error ?? "unknown"}` },
        gpu: gpuByPod.get(`${scrape.namespace}/${scrape.pod}`),
      }))
      .sort((a, b) => rank[a.status.level] - rank[b.status.level] || (a.pod < b.pod ? -1 : 1));
  }

  private async refreshInference() {
    const scrapes = await this.scraper.scrapeInference();
    const out = scrapes.map((scrape) => {
      const key = `${scrape.namespace}/${scrape.pod}`;
      const prev = this.inferencePrev.get(key);
      const rates = scrape.sample
        ? vllmRates(prev?.sample, scrape.sample, prev ? (scrape.at - prev.at) / 1000 : 0)
        : {};
      if (scrape.sample) this.inferencePrev.set(key, { at: scrape.at, sample: scrape.sample });
      return { scrape, rates };
    });
    const live = new Set(scrapes.map((x) => `${x.namespace}/${x.pod}`));
    for (const k of [...this.inferencePrev.keys()]) if (!live.has(k)) this.inferencePrev.delete(k);
    runInAction(() => {
      this.inference = out;
    });
  }

  /** Unscheduled GPU pods, oldest first, with hints the scheduler message does not give. */
  @computed get pendingRows(): PendingRow[] {
    const nodes: NodeGpuResources[] = this.nodes.map((n) => ({ name: n.name, allocatable: n.gpuResources }));
    // Without a node list (RBAC, API error) every request would look unsatisfiable: give no hints rather than wrong ones.
    const canHint = nodes.length > 0 && !this.nodesError;
    return (this.podState?.pending ?? [])
      .map((p) => ({ ...p, hints: canHint ? explainPending(p, nodes) : [] }))
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }

  /** Per node: nvidia.com/gpu capacity / allocatable / requested vs measured devices. */
  @computed get allocation(): AllocationRow[] {
    const snap = this.snapshot;
    const byNode = new Map<string, AllocationRow>();
    const ensure = (name: string) => {
      let a = byNode.get(name);
      if (!a) {
        a = {
          node: name,
          capacity: 0,
          allocatable: 0,
          unhealthy: 0,
          requested: 0,
          requestingPods: [],
          devices: 0,
          busyDevices: 0,
          avgUtilPct: 0,
          vramUsedMiB: 0,
          vramTotalMiB: 0,
          powerWatts: 0,
        };
        byNode.set(name, a);
      }
      return a;
    };
    for (const n of this.nodes) {
      if (n.capacity === 0 && n.allocatable === 0) continue;
      const a = ensure(n.name);
      a.gpuType = n.gpuType;
      a.capacity = n.capacity;
      a.allocatable = n.allocatable;
      a.unhealthy = Math.max(0, n.capacity - n.allocatable);
      a.migFree = migFree(n.gpuResources, this.podState?.requestedByNode[n.name]?.byResource ?? {});
    }
    for (const [node, r] of Object.entries(this.podState?.requestedByNode ?? {})) {
      const a = ensure(node);
      a.requested = r.gpus;
      a.requestingPods = r.pods;
    }
    if (snap) {
      const utilSum = new Map<string, number>();
      for (const d of this.devices) {
        const a = ensure(d.node);
        a.devices++;
        if (d.utilPct >= IDLE_UTIL_PCT || d.pods.length > 0) a.busyDevices++;
        a.vramUsedMiB += d.vramUsedMiB;
        a.vramTotalMiB += d.vramTotalMiB;
        utilSum.set(d.node, (utilSum.get(d.node) ?? 0) + d.utilPct);
        if (!a.gpuType && d.model) a.gpuType = d.model;
      }
      for (const a of byNode.values()) {
        if (a.devices > 0) {
          a.avgUtilPct = (utilSum.get(a.node) ?? 0) / a.devices;
          a.powerWatts = totalPowerW(this.devicesForNode(a.node));
        }
      }
    }
    return [...byNode.values()].sort((x, y) => (x.node < y.node ? -1 : 1));
  }

  private pinsKey(clusterId: string) {
    return `freelens-gpu-extension.pins.${clusterId}`;
  }

  /** Load this cluster's pins once (cluster frames are per cluster, but the key carries the id to be safe). */
  private loadPins() {
    const id = Renderer.Catalog.getActiveCluster()?.id;
    if (!id || this.pinsLoadedFor === id) return;
    this.pinsLoadedFor = id;
    let saved: string[] = [];
    try {
      const raw = localStorage.getItem(this.pinsKey(id));
      const arr = raw ? (JSON.parse(raw) as unknown) : [];
      if (Array.isArray(arr)) saved = arr.filter((x): x is string => typeof x === "string");
    } catch {
      /* private window / blocked storage: no pins */
    }
    const pins = saved.map(parseTarget).filter(isTarget);
    this.scraper.pins = pins;
    runInAction(() => {
      this.pins = pins;
    });
  }

  /** Add a pin from user input; returns an error message for invalid input. */
  addPin(raw: string): string | undefined {
    const t = parseTarget(raw);
    if (!isTarget(t)) return t.error;
    const key = formatTarget(t);
    this.setPins([...this.pins.filter((p) => formatTarget(p) !== key), t]);
    return undefined;
  }

  removePin(t: Target) {
    const key = formatTarget(t);
    this.setPins(this.pins.filter((p) => formatTarget(p) !== key));
  }

  @action private setPins(pins: Target[]) {
    this.pins = pins;
    this.scraper.pins = pins;
    const id = Renderer.Catalog.getActiveCluster()?.id;
    if (id) {
      try {
        localStorage.setItem(this.pinsKey(id), JSON.stringify(pins.map(formatTarget)));
      } catch {
        /* not persisted; still applies for this session */
      }
    }
    this.scraper.invalidate();
    // refresh() returns the in-flight scrape if one is running; chain a fresh one so the pin applies now.
    void (this.inflight ?? Promise.resolve()).then(() => this.refresh(true));
  }

  /** Everything the "Copy snapshot" buttons export. */
  reportInput(extra: { cluster?: string; extensionVersion?: string } = {}): ReportInput {
    return {
      ...extra,
      scrapedAt: this.snapshot?.scrapedAt,
      error: this.error,
      exporters: this.snapshot?.exporters ?? [],
      devices: this.devices,
      pods: this.rows,
      allocation: this.allocation,
      namespaces: this.namespaceRows,
      idle: this.idleRows,
      pending: this.pendingRows,
      inference: this.inferenceRows,
    };
  }

  get isStale(): boolean {
    return !this.snapshot || Date.now() - this.snapshot.scrapedAt.getTime() > STALE_MS;
  }

  /** Refresh now (deduplicated while a scrape is in flight). */
  refresh(force = false): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh(force).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  ensureFresh(): Promise<void> {
    return this.isStale ? this.refresh() : Promise.resolve();
  }

  @action private setLoading(v: boolean) {
    this.loading = v;
  }

  private recordHistory(snap: Snapshot) {
    const t = snap.scrapedAt.getTime();
    const cutoff = t - HISTORY_MS;
    for (const r of snap.rows) {
      if (r.gpuIndex) continue;
      const k = `${r.namespace}/${r.pod}`;
      const h = this.history.get(k) ?? [];
      h.push({ t, utilPct: r.gpuUtilPct, vramUsedMiB: r.vramUsedMiB });
      while (h.length > 0 && h[0].t < cutoff) h.shift();
      this.history.set(k, h);
    }
    // drop pods that vanished
    const live = new Set(snap.rows.map((r) => `${r.namespace}/${r.pod}`));
    for (const k of [...this.history.keys()]) if (!live.has(k)) this.history.delete(k);
  }

  private async loadNodes(force: boolean) {
    if (!force && Date.now() - this.nodesLoadedAt < DISCOVERY_TTL_MS) return;
    this.nodesLoadedAt = Date.now();
    try {
      const list = (await Renderer.K8sApi.nodesApi.list()) ?? [];
      const infos: NodeInfo[] = list.map((n) => {
        const cap = gpuResourceCount(n.status?.capacity as Record<string, string> | undefined);
        const alloc = gpuResourceCount(n.status?.allocatable as Record<string, string> | undefined);
        const labels = n.metadata.labels ?? {};
        const gpuType =
          labels["nvidia.com/gpu.product"] ??
          labels["gpu-type"] ??
          labels["cloud.google.com/gke-accelerator"] ??
          labels["accelerator"];
        const gpuResources: Record<string, number> = {};
        for (const [k, v] of Object.entries((n.status?.allocatable as Record<string, string> | undefined) ?? {})) {
          if (isGpuResourceName(k)) gpuResources[k] = Number(v) || 0;
        }
        const replicas = Number(labels["nvidia.com/gpu.replicas"] ?? 1) || 1;
        return { name: n.getName(), gpuType, capacity: cap, allocatable: alloc, gpuResources, replicas };
      });
      runInAction(() => {
        this.nodes = infos;
        this.nodesError = undefined;
      });
    } catch (e) {
      runInAction(() => {
        this.nodesError = e instanceof Error ? e.message : String(e);
      });
    }
  }

  private async doRefresh(force: boolean) {
    this.loadPins();
    this.setLoading(true);
    try {
      const [snap] = await Promise.all([this.scraper.snapshot(force), this.loadNodes(force)]);
      this.recordHistory(snap);
      runInAction(() => {
        this.snapshot = snap;
        this.error = undefined;
        this.historyVersion++;
      });
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : String(e);
      });
    } finally {
      // Inference servers don't depend on a GPU exporter: scrape them whether or not the snapshot worked.
      try {
        await this.refreshInference();
      } catch {
        /* per-pod errors are recorded on each scrape */
      }
      // Discovery lists pods before it looks for exporters, so this is fresh even when the snapshot threw.
      const ps = this.scraper.podState;
      runInAction(() => {
        this.podState = ps;
      });
      this.setLoading(false);
    }
  }

  /**
   * Reference-counted polling: the first subscriber starts the ticker, the
   * last one stops it. Pages and detail panels call this on mount/unmount.
   */
  subscribe(intervalMs = DEFAULT_INTERVAL_MS): () => void {
    this.subscribers++;
    if (!this.timer) {
      void this.refresh();
      this.timer = setInterval(() => void this.refresh(), intervalMs);
    }
    return () => {
      this.subscribers--;
      if (this.subscribers <= 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
        this.subscribers = 0;
      }
    };
  }
}

export const gpuStore = new GpuStore();
