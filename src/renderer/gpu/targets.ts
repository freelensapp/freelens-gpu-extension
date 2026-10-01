/**
 * Pinned exporter targets, for clusters where auto-discovery guesses wrong
 * (exporter pod without gpu/dcgm/nvidia/cuda in its name/image/labels, metrics
 * on a non-default port) or where GPU metrics live in a Prometheus with an
 * unusual service name.
 *
 *   gpu-mon/my-exporter:9400        exporter pods in gpu-mon whose name starts with "my-exporter"
 *   monitoring/svc/vm-single:8428   a Prometheus-compatible query API behind that service
 *
 * Pods are matched by name prefix because DaemonSet pod names change on every
 * restart.
 */

export type Target =
  | { kind: "pod"; namespace: string; prefix: string; port: number }
  | { kind: "service"; namespace: string; name: string; port: number };

const NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

/** Parse one pin; returns an error message instead of throwing. */
export function parseTarget(raw: string): Target | { error: string } {
  const s = raw.trim();
  const m = /^([^/\s]+)\/(?:(svc)\/)?([^/:\s]+):(\d{1,5})$/.exec(s);
  if (!m) return { error: `"${s}": expected namespace/pod-prefix:port or namespace/svc/name:port` };
  const [, namespace, svc, name, portStr] = m;
  const port = Number(portStr);
  if (!NAME.test(namespace)) return { error: `"${namespace}" is not a valid namespace name` };
  if (!NAME.test(name)) return { error: `"${name}" is not a valid ${svc ? "service" : "pod"} name` };
  if (port < 1 || port > 65535) return { error: `port ${port} is out of range` };
  return svc ? { kind: "service", namespace, name, port } : { kind: "pod", namespace, prefix: name, port };
}

export function formatTarget(t: Target): string {
  return t.kind === "service" ? `${t.namespace}/svc/${t.name}:${t.port}` : `${t.namespace}/${t.prefix}:${t.port}`;
}

export const isTarget = (t: Target | { error: string }): t is Target => !("error" in t);
