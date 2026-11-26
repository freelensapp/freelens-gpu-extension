/**
 * Prometheus fallback: when no exporter pod can be scraped directly, read the
 * same metric families from a Prometheus-compatible query API in the cluster
 * (Prometheus, Thanos Query, VictoriaMetrics, Mimir) through the apiserver's
 * service proxy, and turn the instant-query result back into per-node metric
 * families so the normal aggregation applies unchanged.
 */

import type { Families, Sample } from "./prom";

export interface ServiceLike {
  namespace: string;
  name: string;
  ports: { name?: string; port: number }[];
}

export interface PromTarget {
  namespace: string;
  name: string;
  port: number;
  /** Path the query API is served under, e.g. "/prometheus" for Mimir; "" at the root. */
  prefix?: string;
  /** The service speaks HTTPS (the apiserver proxies to "https:name:port"). */
  https?: boolean;
  /** Where the target comes from, for the Exporters page; undefined for pins and auto-discovery. */
  origin?: "cluster-settings";
}

/** "/prometheus/" or "prometheus" -> "/prometheus"; "" or "/" -> "". */
export function normalizePrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? "").trim().replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}` : "";
}

/** "namespace/svc/name:port" plus the prefix, as pins are written and the Exporters page shows them. */
export function formatPromTarget(t: PromTarget): string {
  return `${t.namespace}/svc/${t.https ? "https:" : ""}${t.name}:${t.port}${normalizePrefix(t.prefix)}`;
}

/** Service-proxy path of an endpoint of the query API, e.g. "query" or "query_range". */
export function promApiPath(t: PromTarget, endpoint: string, params: Record<string, string | number>): string {
  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  const svc = `${t.https ? "https:" : ""}${t.name}:${t.port}`;
  return `/api/v1/namespaces/${t.namespace}/services/${svc}/proxy${normalizePrefix(t.prefix)}/api/v1/${endpoint}?${query}`;
}

/** The Prometheus set in the cluster settings of Freelens (Metrics), as the cluster entity carries it. */
export interface ClusterPrometheusSetting {
  namespace?: string;
  service?: string;
  port?: number | string;
  prefix?: string;
  https?: boolean;
}

const K8S_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
/**
 * Path segments of letters, digits and -._~ only, none of them "." or "..": the prefix ends up in a URL path under the
 * service proxy, and must not climb out of it to other apiserver paths.
 */
const PREFIX = /^(\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~-]+)*$/;

/**
 * The query API set in Freelens for this cluster, or undefined when none is set, it is incomplete, or a part of it
 * would not be a valid path (it is user input, like a pin).
 */
export function clusterSettingTarget(address: ClusterPrometheusSetting | undefined): PromTarget | undefined {
  const port = Number(address?.port);
  if (!address?.namespace || !address.service || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (!K8S_NAME.test(address.namespace) || !K8S_NAME.test(address.service)) return undefined;
  if (!PREFIX.test(normalizePrefix(address.prefix))) return undefined;
  return {
    namespace: address.namespace,
    name: address.service,
    port,
    prefix: normalizePrefix(address.prefix),
    https: address.https === true,
    origin: "cluster-settings",
  };
}

const QUERY_API = /prometheus|thanos-query|thanos-querier|vmselect|vmsingle|victoria-metrics|mimir-query|querier/i;
// Same names, but not query APIs.
const NOT_QUERY =
  /alertmanager|operator|node-exporter|pushgateway|kube-state|blackbox|adapter|webhook|config-reloader/i;
const QUERY_PORT_NAMES = new Set(["web", "http", "http-web", "http-query", "prometheus", "query"]);
const QUERY_PORTS = [9090, 8428, 8481, 9009, 10902, 80];

/** Services that look like a Prometheus-compatible query API, best guess first. */
export function promCandidates(services: ServiceLike[]): PromTarget[] {
  const out: PromTarget[] = [];
  for (const s of services) {
    if (!QUERY_API.test(s.name) || NOT_QUERY.test(s.name)) continue;
    const named = s.ports.find((p) => p.name && QUERY_PORT_NAMES.has(p.name));
    const known = s.ports.find((p) => QUERY_PORTS.includes(p.port));
    const port = (named ?? known)?.port;
    if (port) out.push({ namespace: s.namespace, name: s.name, port });
  }
  // "prometheus-server"/"kube-prometheus-stack-prometheus" before querier-style names; stable otherwise
  const rank = (t: PromTarget) => (/prometheus/i.test(t.name) ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

export function promQueryPath(t: PromTarget, query: string): string {
  return promApiPath(t, "query", { query });
}

export const selectorFor = (names: string[]): string => `{__name__=~"${names.join("|")}"}`;

interface PromVector {
  status?: string;
  error?: string;
  data?: { resultType?: string; result?: { metric: Record<string, string>; value: [number, string] }[] };
}

function parse(json: string): PromVector {
  try {
    return JSON.parse(json) as PromVector;
  } catch {
    throw new Error(`not a Prometheus API response (${json.slice(0, 80)})`);
  }
}

/** Number of series an instant query returned (0 when the API answered but has no such series). */
export function seriesCount(json: string): number {
  const v = parse(json);
  if (v.status !== "success") throw new Error(v.error ?? "query failed");
  return v.data?.result?.length ?? 0;
}

// Added by the scrape, not by the exporter; they make otherwise identical series look different
// (HA Prometheus pairs, several ServiceMonitors on one exporter).
const SCRAPE_LABELS = ["instance", "job", "endpoint", "service", "prometheus", "prometheus_replica", "__replica__"];

/** Pod names of the exporters themselves: a series "attributed" to one of them is really unattributed. */
const EXPORTER_POD = /dcgm-exporter|dcgm_exporter|nvidia-dcgm|gpu-enricher|gpu-exporter/i;

/**
 * Labels of a series as the exporter emitted them, from what a query API returns.
 *
 * Prometheus stores the workload's namespace/pod as exported_namespace/exported_pod when the target's own labels
 * collide, and stamps the exporter pod's namespace/pod on series that carried none. So exported_* win, and a pod
 * that is the exporter itself means "no workload". The labels the scrape adds are dropped, which makes the copies of
 * one series (HA pairs, several ServiceMonitors) identical.
 */
export function repairLabels(metric: Record<string, string>): {
  name: string | undefined;
  labels: Record<string, string>;
  node: string;
} {
  const { __name__: name, ...raw } = metric;
  const labels: Record<string, string> = { ...raw };
  for (const k of ["namespace", "pod", "container"]) {
    if (labels[`exported_${k}`] !== undefined) {
      labels[k] = labels[`exported_${k}`];
      delete labels[`exported_${k}`];
    }
  }
  if (labels.pod && EXPORTER_POD.test(labels.pod)) {
    delete labels.pod;
    delete labels.namespace;
    delete labels.container;
  }
  for (const k of SCRAPE_LABELS) delete labels[k];
  // Service discovery's node label is authoritative; DCGM's Hostname is the exporter pod name unless NODE_NAME is set.
  const node = labels.node || labels.kubernetes_node || labels.nodename || labels.Hostname || "";
  if (node) labels.Hostname = node;
  return { name, labels, node };
}

export interface NodeFamilies {
  node: string;
  kind: "dcgm" | "enricher";
  fams: Families;
}

/**
 * Instant-query vector → families per (exporter kind, node), with the labels repaired (see repairLabels).
 */
export function promResultToNodeFamilies(json: string): NodeFamilies[] {
  const v = parse(json);
  if (v.status !== "success") throw new Error(v.error ?? "query failed");
  const groups = new Map<string, NodeFamilies>();
  const seen = new Set<string>();
  for (const r of v.data?.result ?? []) {
    const { name, labels, node } = repairLabels(r.metric);
    if (!name) continue;
    const key = `${name}{${Object.keys(labels)
      .sort()
      .map((k) => `${k}=${labels[k]}`)
      .join(",")}}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const value = Number(r.value?.[1]);
    if (!Number.isFinite(value)) continue;
    const kind = name.startsWith("DCGM_") ? "dcgm" : "enricher";
    const gk = `${kind}/${node}`;
    let g = groups.get(gk);
    if (!g) {
      g = { node, kind, fams: new Map() };
      groups.set(gk, g);
    }
    const sample: Sample = { name, labels, value };
    const arr = g.fams.get(name);
    if (arr) arr.push(sample);
    else g.fams.set(name, [sample]);
  }
  return [...groups.values()];
}
