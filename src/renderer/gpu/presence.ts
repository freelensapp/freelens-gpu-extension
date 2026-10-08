/**
 * Whether a pod or node can have anything to show in the GPU drawer sections, from the object alone. The drawers use
 * it to decide whether to start polling, so opening an ordinary pod or node does not list the whole cluster.
 */

import { isGpuResourceName, usesGpuResource } from "./aggregate";

/** A pod that references DRA claims (spec.resourceClaims): it may hold a GPU without any nvidia.com/gpu request. */
export function podUsesClaims(spec: { resourceClaims?: unknown[] } | undefined): boolean {
  return (spec?.resourceClaims?.length ?? 0) > 0;
}

interface ContainerLike {
  resources?: { limits?: unknown; requests?: unknown };
  env?: { name: string; value?: string }[];
}

/**
 * The pod requests a GPU resource (whole, MIG slice or time-sliced replica), or sets NVIDIA_VISIBLE_DEVICES: workloads
 * that bypass the device plugin that way are attributed by a per-process exporter.
 */
export function podMayUseGpu(containers: ContainerLike[]): boolean {
  return containers.some(
    (c) =>
      usesGpuResource(c.resources?.limits as Record<string, string> | undefined) ||
      usesGpuResource(c.resources?.requests as Record<string, string> | undefined) ||
      (c.env ?? []).some(
        (e) => e.name === "NVIDIA_VISIBLE_DEVICES" && !["", "void", "none"].includes((e.value ?? "").trim()),
      ),
  );
}

/** The node advertises a GPU resource (nvidia.com/gpu or a MIG profile), even with zero devices allocatable. */
export function nodeAdvertisesGpu(capacity: Record<string, string> | undefined): boolean {
  return Object.keys(capacity ?? {}).some(isGpuResourceName);
}
