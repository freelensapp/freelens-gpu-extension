/**
 * Exporter discovery + scraping from inside the Freelens renderer.
 *
 * Same strategy as kubectl-gpugo: list pods, keep the ones whose name /
 * image / labels look GPU-related, probe each candidate's /metrics through
 * the kube-apiserver pod-proxy subresource, and classify by the metric
 * families it emits. Nothing is installed in the cluster.
 *
 * All requests go through Freelens' own cluster connection
 * (KubeJsonApi.forCluster), so they carry whatever auth the kubeconfig has.
 */

import { Common, Renderer } from "@freelensapp/extensions";
import {
  aggregateByGPU,
  aggregateByPod,
  aggregateDevicesDcgm,
  aggregateDevicesEnricher,
  buildEnricherRows,
  DCGM_METRICS,
  ENRICHER_METRICS,
  extractDcgmSamples,
  gpuResourceCount,
  usesGpuResource,
} from "./aggregate";
import { classifyInference, INFERENCE_HINT, type InferenceEngine, parseVllm, type VllmSample } from "./inference";
import { gpuRequestsOf, type PendingGpuPod } from "./pending";
import { classifyMetrics, type Families, parsePrometheusText } from "./prom";
import {
  type PromTarget,
  promCandidates,
  promQueryPath,
  promResultToNodeFamilies,
  type ServiceLike,
  selectorFor,
  seriesCount,
} from "./prometheus";

import type { Target } from "./targets";
import type { ExporterPod, ExporterScrape, GpuDevice, GpuRequests, PodGPU, PodState, Snapshot } from "./types";

type Pod = Renderer.K8sApi.Pod;

const GPU_KEYWORDS = ["dcgm", "gpu", "nvidia", "cuda"];
const PROBE_TIMEOUT_MS = 5_000;
const SCRAPE_TIMEOUT_MS = 15_000;
/** Discovery (pod list, probes) and the Prometheus search are reused this long, also when they found nothing. */
export const DISCOVERY_TTL_MS = 60_000;

function metricsPath(ns: string, name: string, port: number): string {
  return `/api/v1/namespaces/${ns}/pods/${name}:${port}/proxy/metrics`;
}

/**
 * Name, images and labels of a pod, lower-cased, for keyword matching. The node name is taken out of the pod name:
 * static pods are named after their node (kube-apiserver-<node>), and GPU node pools often have "gpu" in the node name,
 * which would make every control plane pod a candidate.
 */
function podHaystack(pod: Pod): string {
  const node = pod.getNodeName();
  return [
    node ? pod.getName().replaceAll(node, "") : pod.getName(),
    ...pod.getContainers().map((c) => c.image ?? ""),
    ...Object.entries(pod.metadata.labels ?? {}).flatMap(([k, v]) => [k, v]),
  ]
    .join(" ")
    .toLowerCase();
}

/** Where an inference server serves /metrics: annotation, a port named metrics/http, vLLM's default 8000, else the first. */
function inferencePort(pod: Pod): number {
  const ann = pod.metadata.annotations?.["prometheus.io/port"];
  if (ann && /^\d+$/.test(ann)) return Number(ann);
  const ports = pod.getContainers().flatMap((c) => c.ports ?? []);
  return (
    ports.find((p) => p.name === "metrics")?.containerPort ??
    ports.find((p) => p.name === "http")?.containerPort ??
    ports.find((p) => p.containerPort === 8000)?.containerPort ??
    ports[0]?.containerPort ??
    0
  );
}

export interface InferenceTarget {
  namespace: string;
  pod: string;
  node: string;
  port: number;
  engine: InferenceEngine;
}

export interface InferenceScrape extends InferenceTarget {
  at: number;
  sample?: VllmSample;
  error?: string;
}

/** A definite "no" (a /metrics without engine metrics, or 404) is remembered longer than a failed probe. */
const NOT_INFERENCE_TTL_MS = 10 * 60_000;
const PROBE_FAILED_RETRY_MS = 2 * 60_000;

/** Containers not ready yet (vLLM loads its model for minutes after the pod is Running): probe later, remember nothing. */
function containersReady(pod: Pod): boolean {
  const cs = pod.status?.containerStatuses;
  return !cs || cs.every((c) => c.ready);
}

function looksGpuRelated(pod: Pod): boolean {
  const hay = podHaystack(pod);
  return GPU_KEYWORDS.some((k) => hay.includes(k));
}

/** annotation prometheus.io/port > container port named "metrics" > first port. */
function metricsPort(pod: Pod): number {
  const ann = pod.metadata.annotations?.["prometheus.io/port"];
  if (ann && /^\d+$/.test(ann)) return Number(ann);
  const ports = pod.getContainers().flatMap((c) => c.ports ?? []);
  const named = ports.find((p) => p.name === "metrics");
  if (named) return named.containerPort;
  return ports[0]?.containerPort ?? 0;
}

/** GPU devices (nvidia.com/gpu + MIG slices, not *.shared replicas) requested by a pod: container limits, falling back to requests. */
function gpusRequested(pod: Pod): number {
  let n = 0;
  for (const c of pod.getContainers()) {
    const r = c.resources ?? {};
    const lim = gpuResourceCount(r.limits as Record<string, string> | undefined);
    n += lim > 0 ? lim : gpuResourceCount(r.requests as Record<string, string> | undefined);
  }
  return n;
}

/** Pod uses a GPU at all (whole, MIG slice, or time-sliced replica). */
function requestsGpu(pod: Pod): boolean {
  return pod.getContainers().some((c) => {
    const r = c.resources ?? {};
    return (
      usesGpuResource(r.limits as Record<string, string> | undefined) ||
      usesGpuResource(r.requests as Record<string, string> | undefined)
    );
  });
}

/** A Pending pod the scheduler has not placed yet (PodScheduled != True); pods pulling images are not "waiting for a GPU". */
function pendingOf(pod: Pod): PendingGpuPod[] {
  const cond = pod.status?.conditions?.find((c) => c.type === "PodScheduled");
  if (cond?.status === "True") return [];
  const created = Date.parse(pod.metadata.creationTimestamp ?? "");
  return [
    {
      namespace: pod.getNs(),
      pod: pod.getName(),
      createdAt: Number.isNaN(created) ? undefined : created,
      requests: gpuRequestsOf(pod.getContainers()),
      reason: cond?.reason,
      message: cond?.message,
    },
  ];
}

export interface ScraperDeps {
  clusterId: () => string | undefined;
  listPods: () => Promise<Pod[]>;
  /** Services, for the Prometheus fallback. */
  listServices: () => Promise<ServiceLike[]>;
  fetchText: (clusterId: string, path: string, timeoutMs: number) => Promise<string>;
}

const defaultDeps: ScraperDeps = {
  clusterId: () => Renderer.Catalog.getActiveCluster()?.id ?? Renderer.Catalog.activeCluster.get()?.getId(),
  listPods: async () => (await Renderer.K8sApi.podsApi.list()) ?? [],
  listServices: async () =>
    ((await Renderer.K8sApi.serviceApi.list()) ?? []).map((svc) => ({
      namespace: svc.getNs() ?? "",
      name: svc.getName(),
      ports: (svc.spec?.ports ?? []).map((p) => ({ name: p.name, port: p.port })),
    })),
  fetchText: async (clusterId, path, timeoutMs) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      // Inside a cluster frame the window origin IS the Lens proxy for this
      // cluster, and /api-kube/* is forwarded to the kube-apiserver with the
      // kubeconfig's auth. This is the path Freelens itself uses.
      //
      // The typed KubeJsonApi.forCluster(clusterId) is only used when the
      // running Freelens actually provides it (1.10.3 declares it in the
      // typings but not at runtime).
      const forCluster = (Renderer.K8sApi.KubeJsonApi as unknown as { forCluster?: unknown }).forCluster;
      if (typeof forCluster === "function") {
        try {
          const api = Renderer.K8sApi.KubeJsonApi.forCluster(clusterId);
          const body = await api.get<unknown>(path, undefined, { signal: ctrl.signal });
          return typeof body === "string" ? body : JSON.stringify(body);
        } catch (e) {
          log.warn(`KubeJsonApi.forCluster GET ${path} failed, falling back to /api-kube: ${describe(e)}`);
        }
      }
      const res = await fetch(`/api-kube${path}`, { signal: ctrl.signal, credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for /api-kube${path}`);
      return await res.text();
    } finally {
      clearTimeout(t);
    }
  },
};

const log = {
  info: (m: string) => Common.logger.info(`[freelens-gpu-extension] ${m}`),
  warn: (m: string) => Common.logger.warn(`[freelens-gpu-extension] ${m}`),
};

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export interface ProbeResult {
  target: string;
  outcome: "dcgm" | "enricher" | "prometheus" | "unrecognised" | "error";
  detail?: string;
}

export class GpuScraper {
  private discovered: ExporterPod[] = [];
  private discoveredAt = 0;
  /** Pods requesting nvidia.com/gpu grouped by node, refreshed with discovery. */
  private gpuPodsByNode = new Map<string, string[]>();
  /** Pod-derived state from the last successful pod list (undefined until one succeeds). */
  podState: PodState | undefined = undefined;
  /** Probes of the last discovery pass and of the last Prometheus search; see lastProbes. */
  private discoveryProbes: ProbeResult[] = [];
  private promProbes: ProbeResult[] = [];
  lastCandidateCount = 0;
  lastPodCount = 0;

  constructor(private readonly deps: ScraperDeps = defaultDeps) {}

  /** Pinned targets (user setting): probed in addition to auto-discovery; services are tried as Prometheus first. */
  pins: Target[] = [];
  /** Prometheus query API chosen by the last fallback, reused until discovery runs again. */
  private prom: PromTarget | undefined;
  /** When the last Prometheus search found nothing; services are not listed again within DISCOVERY_TTL_MS. */
  private promMissAt = 0;
  /** Inference servers found by the last discovery. */
  inferenceTargets: InferenceTarget[] = [];
  /** Pods probed and found not to be inference servers ("ns/pod" -> retry after), so GPU pods are not re-probed every tick. */
  private notInference = new Map<string, number>();

  invalidate() {
    this.discoveredAt = 0;
    this.prom = undefined;
    this.promMissAt = 0;
  }

  /** Outcome of the last discovery pass and Prometheus search, for diagnostics in the UI and logs. */
  get lastProbes(): ProbeResult[] {
    return [...this.discoveryProbes, ...this.promProbes];
  }

  get exporters(): ExporterPod[] {
    return this.discovered;
  }

  async discover(force = false): Promise<ExporterPod[]> {
    // An empty result is cached too: on a cluster without GPUs every tick would list all the pods again.
    if (!force && Date.now() - this.discoveredAt < DISCOVERY_TTL_MS) {
      return this.discovered;
    }
    const clusterId = this.deps.clusterId();
    if (!clusterId) throw new Error("no active cluster");

    const pods = await this.deps.listPods();
    this.lastPodCount = pods.length;
    const byNode = new Map<string, string[]>();
    const requested: Record<string, GpuRequests> = {};
    const requestedNs: Record<string, GpuRequests> = {};
    const add = (m: Record<string, GpuRequests>, key: string, p: Pod, id: string) => {
      const r = (m[key] ??= { gpus: 0, byResource: {}, pods: [] });
      r.gpus += gpusRequested(p);
      for (const [k, v] of Object.entries(gpuRequestsOf(p.getContainers())))
        r.byResource[k] = (r.byResource[k] ?? 0) + v;
      r.pods.push(id);
    };
    for (const p of pods) {
      if (!requestsGpu(p)) continue;
      const phase = p.getStatusPhase();
      const n = p.getNodeName() ?? "";
      const id = `${p.getNs()}/${p.getName()}`;
      if (phase === "Running") byNode.set(n, [...(byNode.get(n) ?? []), id]);
      // The scheduler counts a device as taken as soon as the pod is bound, not when it starts running
      // (image pull, init containers), so bound Pending pods hold devices too.
      if (phase === "Running" || (phase === "Pending" && n)) {
        add(requested, n, p, id);
        add(requestedNs, p.getNs(), p, id);
      }
    }
    this.gpuPodsByNode = byNode;
    this.podState = {
      listedAt: new Date(),
      requestedByNode: requested,
      requestedByNamespace: requestedNs,
      pending: pods.filter((p) => p.getStatusPhase() === "Pending" && requestsGpu(p)).flatMap(pendingOf),
    };

    type Candidate = { ns: string; name: string; port: number; node: string };
    const auto: Candidate[] = pods
      .filter((p) => p.getStatusPhase() === "Running" && looksGpuRelated(p))
      .map((p) => ({ ns: p.getNs(), name: p.getName(), port: metricsPort(p), node: p.getNodeName() ?? "" }))
      .filter((c) => c.port > 0);
    // Pinned pods: any Running pod whose name starts with the prefix, at the pinned port, whatever it looks like.
    const pinned: Candidate[] = this.pins.flatMap((t) =>
      t.kind !== "pod"
        ? []
        : pods
            .filter(
              (p) => p.getNs() === t.namespace && p.getName().startsWith(t.prefix) && p.getStatusPhase() === "Running",
            )
            .map((p) => ({ ns: t.namespace, name: p.getName(), port: t.port, node: p.getNodeName() ?? "" })),
    );
    const byId = new Map<string, Candidate>();
    for (const c of [...auto, ...pinned]) byId.set(`${c.ns}/${c.name}`, c); // a pin overrides the guessed port
    const candidates = [...byId.values()];
    const inferenceProbe = this.discoverInference(pods, clusterId);
    this.lastCandidateCount = candidates.length;
    const probes: ProbeResult[] = [];
    const probed = await Promise.all(
      candidates.map(async (c): Promise<ExporterPod | undefined> => {
        const target = `${c.ns}/${c.name}:${c.port}`;
        try {
          const text = await this.deps.fetchText(clusterId, metricsPath(c.ns, c.name, c.port), PROBE_TIMEOUT_MS);
          const kind = classifyMetrics(text);
          if (!kind) {
            probes.push({
              target,
              outcome: "unrecognised",
              detail: `${text.length} bytes, first line: ${text.split("\n")[0]?.slice(0, 80)}`,
            });
            return undefined;
          }
          probes.push({ target, outcome: kind });
          return { namespace: c.ns, name: c.name, port: c.port, nodeName: c.node, kind };
        } catch (e) {
          probes.push({ target, outcome: "error", detail: describe(e) });
          return undefined;
        }
      }),
    );
    await inferenceProbe;
    this.discoveryProbes = probes;
    this.discovered = probed.filter((x): x is ExporterPod => !!x);
    this.discoveredAt = Date.now();
    log.info(
      `discovery: ${pods.length} pods, ${candidates.length} candidates, ${this.discovered.length} exporters; ` +
        probes.map((p) => `${p.target}=${p.outcome}${p.detail ? ` (${p.detail})` : ""}`).join("; "),
    );
    return this.discovered;
  }

  /**
   * Inference servers: Running pods that request a GPU or look like one (vllm, sglang, triton, kserve), probed once and
   * kept when their /metrics carries an engine's metrics. Pods that are not are skipped for 10 minutes.
   */
  private async discoverInference(pods: Pod[], clusterId: string): Promise<void> {
    const now = Date.now();
    for (const [k, until] of this.notInference) if (until <= now) this.notInference.delete(k);
    const known = new Map(this.inferenceTargets.map((t) => [`${t.namespace}/${t.pod}`, t]));
    const next: InferenceTarget[] = [];
    await Promise.all(
      pods
        .filter((p) => p.getStatusPhase() === "Running" && (requestsGpu(p) || INFERENCE_HINT.test(podHaystack(p))))
        .map(async (p) => {
          const key = `${p.getNs()}/${p.getName()}`;
          const hit = known.get(key);
          if (hit) {
            next.push(hit);
            return;
          }
          if (this.notInference.has(key) || !containersReady(p)) return;
          const port = inferencePort(p);
          if (port <= 0) return;
          try {
            const engine = classifyInference(
              await this.deps.fetchText(clusterId, metricsPath(p.getNs(), p.getName(), port), PROBE_TIMEOUT_MS),
            );
            if (engine) {
              next.push({ namespace: p.getNs(), pod: p.getName(), node: p.getNodeName() ?? "", port, engine });
              return;
            }
            this.notInference.set(key, now + NOT_INFERENCE_TTL_MS);
          } catch (e) {
            // 404: nothing at /metrics, a definite no. Anything else (refused, timeout, 5xx): try again soon.
            this.notInference.set(
              key,
              now + (/\b404\b/.test(describe(e)) ? NOT_INFERENCE_TTL_MS : PROBE_FAILED_RETRY_MS),
            );
          }
        }),
    );
    this.inferenceTargets = next.sort((a, b) => (`${a.namespace}/${a.pod}` < `${b.namespace}/${b.pod}` ? -1 : 1));
  }

  /** Scrape every inference server found by discovery; independent of the GPU exporters. */
  async scrapeInference(): Promise<InferenceScrape[]> {
    const clusterId = this.deps.clusterId();
    if (!clusterId) return [];
    return Promise.all(
      this.inferenceTargets.map(async (t): Promise<InferenceScrape> => {
        try {
          const text = await this.deps.fetchText(clusterId, metricsPath(t.namespace, t.pod, t.port), SCRAPE_TIMEOUT_MS);
          return { ...t, at: Date.now(), sample: parseVllm(parsePrometheusText(text)) };
        } catch (e) {
          return { ...t, at: Date.now(), error: describe(e) };
        }
      }),
    );
  }

  async snapshot(force = false): Promise<Snapshot> {
    if (force) {
      this.prom = undefined;
      this.promMissAt = 0;
    }
    const exporters = await this.discover(force);
    const clusterId = this.deps.clusterId();
    if (!clusterId) throw new Error("no active cluster");
    if (exporters.length === 0) {
      const viaProm = await this.fromPrometheus(clusterId);
      if (viaProm) return this.aggregate(viaProm.bodies, viaProm.scraped);
      const lines = [
        `No GPU metrics exporter found (${this.lastPodCount} pods listed, ${this.lastCandidateCount} GPU-looking candidates probed).`,
        "An exporter is recognised when its /metrics emits DCGM_FI_DEV_* or gpu_process_memory_bytes; no Prometheus-compatible",
        "query API with those series was found either. Pin a target on the Exporters page if discovery misses yours.",
        ...this.lastProbes.map((p) => `  ${p.target}: ${p.outcome}${p.detail ? ` — ${p.detail}` : ""}`),
      ];
      if (this.lastCandidateCount === 0 && this.lastPodCount === 0) {
        lines.push("  (no pods returned at all — check that this kubeconfig can list pods cluster-wide)");
      }
      throw new Error(lines.join("\n"));
    }

    const scraped: ExporterScrape[] = [];
    const bodies = await Promise.all(
      exporters.map(async (ex) => {
        const t0 = performance.now();
        try {
          const text = await this.deps.fetchText(
            clusterId,
            metricsPath(ex.namespace, ex.name, ex.port),
            SCRAPE_TIMEOUT_MS,
          );
          scraped.push({ ...ex, latencyMs: Math.round(performance.now() - t0), bytes: text.length });
          return { ex, fams: parsePrometheusText(text) };
        } catch (e) {
          scraped.push({ ...ex, latencyMs: Math.round(performance.now() - t0), error: describe(e) });
          return undefined;
        }
      }),
    );
    const ok = bodies.filter((b): b is NonNullable<typeof b> => !!b);
    if (ok.length === 0) {
      throw new Error(
        `All ${exporters.length} exporter scrapes failed: ${scraped.map((s) => `${s.namespace}/${s.name}: ${s.error}`).join("; ")}`,
      );
    }

    // A scrape failing usually means the exporter pod was replaced; rediscover next tick.
    if (ok.length < exporters.length) this.invalidate();
    return this.aggregate(ok, scraped);
  }

  /**
   * No exporter pod answered: look for a Prometheus-compatible query API (pinned services first, then services that
   * look like one), take the first that has GPU series, and read every family we use in a single instant query.
   */
  private async fromPrometheus(
    clusterId: string,
  ): Promise<{ bodies: { ex: ExporterPod; fams: Families }[]; scraped: ExporterScrape[] } | undefined> {
    const probe = selectorFor(["DCGM_FI_DEV_FB_USED", "gpu_process_memory_bytes"]);
    let target = this.prom;
    if (!target) {
      // Nothing found a moment ago: keep that answer (and its probes) instead of listing every service again.
      if (Date.now() - this.promMissAt < DISCOVERY_TTL_MS) return undefined;
      this.promProbes = [];
      let services: ServiceLike[] = [];
      try {
        services = await this.deps.listServices();
      } catch (e) {
        this.promProbes.push({ target: "services", outcome: "error", detail: `list services: ${describe(e)}` });
      }
      const pinned: PromTarget[] = this.pins.flatMap((t) =>
        t.kind === "service" ? [{ namespace: t.namespace, name: t.name, port: t.port }] : [],
      );
      const seen = new Set<string>();
      const candidates = [...pinned, ...promCandidates(services)]
        .filter((t) => !seen.has(`${t.namespace}/${t.name}`) && seen.add(`${t.namespace}/${t.name}`))
        .slice(0, 6);
      for (const t of candidates) {
        const label = `prometheus ${t.namespace}/svc/${t.name}:${t.port}`;
        try {
          const n = seriesCount(
            await this.deps.fetchText(clusterId, promQueryPath(t, `count(${probe})`), PROBE_TIMEOUT_MS),
          );
          if (n > 0) {
            this.promProbes.push({ target: label, outcome: "prometheus" });
            target = t;
            break;
          }
          this.promProbes.push({
            target: label,
            outcome: "unrecognised",
            detail: "query API answers but has no GPU series",
          });
        } catch (e) {
          this.promProbes.push({ target: label, outcome: "error", detail: describe(e) });
        }
      }
      if (!target) {
        this.promMissAt = Date.now();
        return undefined;
      }
      this.prom = target;
    }
    const t0 = performance.now();
    let text: string;
    let groups: ReturnType<typeof promResultToNodeFamilies>;
    try {
      text = await this.deps.fetchText(
        clusterId,
        promQueryPath(target, selectorFor([...DCGM_METRICS, ...ENRICHER_METRICS])),
        SCRAPE_TIMEOUT_MS,
      );
      groups = promResultToNodeFamilies(text);
    } catch (e) {
      // Forget it so the next tick probes again (it may be restarting, or another candidate may work).
      this.prom = undefined;
      this.promProbes = [
        {
          target: `prometheus ${target.namespace}/svc/${target.name}:${target.port}`,
          outcome: "error",
          detail: `query failed: ${describe(e)}`,
        },
      ];
      return undefined;
    }
    const latencyMs = Math.round(performance.now() - t0);
    const bodies = groups.map((g) => ({
      ex: {
        namespace: target.namespace,
        name: target.name,
        port: target.port,
        nodeName: g.node,
        kind: g.kind,
        via: "prometheus" as const,
      },
      fams: g.fams,
    }));
    if (bodies.length === 0) {
      this.prom = undefined;
      return undefined;
    }
    const scraped: ExporterScrape[] = [...new Set(bodies.map((b) => b.ex.kind))].map((kind) => ({
      namespace: target.namespace,
      name: target.name,
      port: target.port,
      nodeName: [...new Set(bodies.filter((b) => b.ex.kind === kind).map((b) => b.ex.nodeName))].join(", "),
      kind,
      via: "prometheus",
      latencyMs,
      bytes: text.length,
    }));
    return { bodies, scraped };
  }

  /** Scraped families (from exporter pods or a Prometheus) → rows and devices. */
  private aggregate(ok: { ex: ExporterPod; fams: Families }[], scraped: ExporterScrape[]): Snapshot {
    const enrichers = ok.filter((b) => b.ex.kind === "enricher");
    const dcgms = ok.filter((b) => b.ex.kind === "dcgm");

    // Pod rows: the per-process exporter where it reports, DCGM for every other
    // node (mixed node pools must not drop the DCGM-only nodes).
    let mode: Snapshot["mode"] = "pod";
    let rows: PodGPU[] =
      enrichers.length > 0 ? buildEnricherRows(enrichers.map((b) => ({ fams: b.fams, node: b.ex.nodeName }))) : [];
    const enricherNodes = new Set(rows.map((r) => r.node));
    const dcgmRest = dcgms.filter((b) => !enricherNodes.has(b.ex.nodeName));
    if (dcgmRest.length > 0) {
      const samples = dcgmRest.flatMap((b) => extractDcgmSamples(b.fams, b.ex.nodeName));
      let dcgmRows = aggregateByPod(samples);
      if (dcgmRows.length === 0) {
        dcgmRows = aggregateByGPU(samples).map((r) => ({ ...r, hintPods: this.gpuPodsByNode.get(r.node) ?? [] }));
        if (dcgmRows.length > 0) mode = "gpu";
      }
      rows = rows.concat(dcgmRows);
    }

    // Devices: prefer DCGM (true device gauges); use the per-process exporter
    // for nodes DCGM does not cover.
    let gpus: GpuDevice[] = dcgms.flatMap((b) => aggregateDevicesDcgm(b.fams, b.ex.nodeName));
    if (enrichers.length > 0) {
      const covered = new Set(gpus.map((d) => d.node));
      const fromEnricher = aggregateDevicesEnricher(enrichers.map((b) => ({ fams: b.fams, node: b.ex.nodeName })));
      gpus = gpus.concat(fromEnricher.filter((d) => !covered.has(d.node)));
    }

    return { scrapedAt: new Date(), mode, rows, gpus, exporters: scraped };
  }
}
