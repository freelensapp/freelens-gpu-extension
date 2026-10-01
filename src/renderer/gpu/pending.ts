/**
 * Pods waiting for a GPU: unscheduled pods that request a GPU resource, the
 * scheduler's own reason, and structural hints that the scheduler message
 * does not spell out (a resource name no node advertises, or more devices
 * than any single node has).
 *
 * Pure functions over plain objects so they can be tested without Freelens.
 */

import { isGpuResourceName } from "./aggregate";

export interface PendingGpuPod {
  namespace: string;
  pod: string;
  /** Epoch ms of metadata.creationTimestamp, if known. */
  createdAt?: number;
  /** GPU resources requested per resource name (container limits, falling back to requests), summed over containers. */
  requests: Record<string, number>;
  /** PodScheduled condition reason, e.g. "Unschedulable". */
  reason?: string;
  /** Scheduler message, e.g. "0/3 nodes are available: 3 Insufficient nvidia.com/gpu." */
  message?: string;
}

/** GPU resources a node advertises as allocatable, by resource name. */
export interface NodeGpuResources {
  name: string;
  allocatable: Record<string, number>;
}

interface ContainerLike {
  resources?: { limits?: Record<string, string | undefined>; requests?: Record<string, string | undefined> };
}

/** GPU resources per resource name: each container's limits, falling back to its requests. */
export function gpuRequestsOf(containers: ContainerLike[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of containers) {
    const pick = (rl?: Record<string, string | undefined>) =>
      Object.entries(rl ?? {}).filter(([k, v]) => isGpuResourceName(k) && (Number(v) || 0) > 0);
    const lim = pick(c.resources?.limits);
    for (const [k, v] of lim.length > 0 ? lim : pick(c.resources?.requests)) out[k] = (out[k] ?? 0) + Number(v);
  }
  return out;
}

const short = (r: string) => r.replace(/^nvidia\.com\//, "");

/** "mig-1g.10gb ×46, gpu ×1" — what the cluster offers in total, largest first. */
function offered(nodes: NodeGpuResources[]): string {
  const total: Record<string, number> = {};
  for (const n of nodes) for (const [k, v] of Object.entries(n.allocatable)) if (v > 0) total[k] = (total[k] ?? 0) + v;
  return Object.entries(total)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${short(k)} ×${v}`)
    .join(", ");
}

/**
 * Hints for one pending pod. Empty when nothing is structurally wrong, i.e.
 * the pod is simply waiting for busy devices (the scheduler message says so).
 */
export function explainPending(p: PendingGpuPod, nodes: NodeGpuResources[]): string[] {
  const hints: string[] = [];
  for (const [res, want] of Object.entries(p.requests)) {
    const perNode = nodes.map((n) => n.allocatable[res] ?? 0);
    const max = Math.max(0, ...perNode);
    if (max === 0) {
      const have = offered(nodes);
      let h = `No node offers ${short(res)}.`;
      if (have) h += ` The cluster offers: ${have}.`;
      if (
        res === "nvidia.com/gpu" &&
        nodes.some((n) => Object.entries(n.allocatable).some(([k, v]) => k.startsWith("nvidia.com/mig-") && v > 0))
      ) {
        h += " GPUs are partitioned (MIG, strategy=mixed): request a slice such as nvidia.com/mig-1g.10gb instead.";
      }
      hints.push(h);
    } else if (want > max) {
      hints.push(`Needs ${want} ${short(res)} on one node; the most any node has is ${max}.`);
    }
  }
  return hints;
}
