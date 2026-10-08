/**
 * GPUs allocated with Dynamic Resource Allocation (resource.k8s.io). On DRA nodes a pod holds a GPU through a
 * ResourceClaim instead of an nvidia.com/gpu count, so the device plugin's view (node capacity, container limits)
 * misses it. This module reads the DRA objects:
 *
 * - ResourceSlice: the devices of a driver on a node (gpu-0, gpu-0-mig-1g10gb-19-0) with their attributes;
 * - ResourceClaim: the devices allocated to a claim (status.allocation.devices.results) and the pods using it
 *   (status.reservedFor, or the owner pod of a claim generated from a template).
 *
 * Pure functions over the JSON of the list endpoints, for resource.k8s.io/v1 and the v1beta2 / v1beta1 shapes of
 * Kubernetes 1.32 and 1.33 (v1beta1 wraps a device in "basic" and puts deviceClassName directly on the request).
 */

/** DRA drivers whose devices are GPUs. NVIDIA's dra-driver-nvidia-gpu publishes whole GPUs and MIG slices. */
export const DRA_GPU_DRIVERS: ReadonlySet<string> = new Set(["gpu.nvidia.com"]);

/** Device classes that select GPUs: gpu.nvidia.com, mig.nvidia.com, and the like (not the ComputeDomain classes). */
export function isGpuDeviceClass(name: string): boolean {
  return /(^|\.)nvidia\.com$/.test(name) && !/compute-domain/.test(name);
}

export interface DraDevice {
  node: string;
  driver: string;
  pool: string;
  /** Device name within the pool, e.g. "gpu-0" or "gpu-2-mig-1g10gb-19-0". */
  name: string;
  /** "gpu" or "mig" for the NVIDIA driver. */
  type?: string;
  uuid?: string;
  /** Card of a MIG slice. */
  parentUuid?: string;
  product?: string;
  /** MIG profile, e.g. "1g.10gb". */
  profile?: string;
  memoryMiB?: number;
}

export interface DraRequest {
  name: string;
  /** Device classes that can satisfy the request (one, or the alternatives of firstAvailable). */
  deviceClasses: string[];
  /** Devices asked for (ExactCount); 1 for an "All" request, whose size depends on the cluster. */
  count: number;
}

export interface DraClaim {
  namespace: string;
  name: string;
  requests: DraRequest[];
  /** Allocated devices; empty while the claim is pending. */
  allocated: { driver: string; pool: string; device: string }[];
  /** Pods using the claim ("ns/pod"): status.reservedFor, else the owner pod of a template-generated claim. */
  pods: string[];
}

export interface DraState {
  devices: DraDevice[];
  claims: DraClaim[];
}

type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** Attribute value ({string}, {int}, {bool} or {version}), by plain name or qualified with the driver's domain. */
function attr(attrs: Json, key: string, driver: string): string | undefined {
  const a = obj(attrs[key] ?? attrs[`${driver}/${key}`]);
  const v = a.string ?? a.version ?? a.int ?? a.bool;
  return v === undefined || v === null ? undefined : String(v);
}

const UNITS: Record<string, number> = {
  Ki: 1 / 1024,
  Mi: 1,
  Gi: 1024,
  Ti: 1024 * 1024,
  k: 1000 / 1024 / 1024,
  M: 1e6 / 1024 / 1024,
  G: 1e9 / 1024 / 1024,
  T: 1e12 / 1024 / 1024,
};

/** A Kubernetes quantity ("80Gi", "9728Mi", "40G", bytes) in MiB; undefined if it does not parse. */
export function quantityMiB(q: string | undefined): number | undefined {
  const m = q?.trim().match(/^(\d+(?:\.\d+)?)([KMGT]i?|k)?$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2] ? n * (UNITS[m[2]] ?? Number.NaN) : n / 1024 / 1024;
}

/** GPU devices of the known GPU drivers in a ResourceSliceList. Slices of other drivers are ignored. */
export function parseResourceSlices(list: unknown): DraDevice[] {
  const out: DraDevice[] = [];
  for (const item of arr(obj(list).items)) {
    const spec = obj(obj(item).spec);
    const driver = str(spec.driver);
    const node = str(spec.nodeName);
    if (!driver || !node || !DRA_GPU_DRIVERS.has(driver)) continue;
    const pool = str(obj(spec.pool).name) ?? node;
    for (const d of arr(spec.devices)) {
      const dev = obj(d);
      const name = str(dev.name);
      if (!name) continue;
      const body = dev.basic ? obj(dev.basic) : dev; // v1beta1 wraps attributes and capacity in "basic"
      const attrs = obj(body.attributes);
      const capacity = obj(body.capacity);
      const memory = obj(capacity.memory ?? capacity[`${driver}/memory`]);
      out.push({
        node,
        driver,
        pool,
        name,
        type: attr(attrs, "type", driver),
        uuid: attr(attrs, "uuid", driver),
        parentUuid: attr(attrs, "parentUUID", driver),
        product: attr(attrs, "productName", driver),
        profile: attr(attrs, "profile", driver),
        memoryMiB: quantityMiB(str(memory.value)),
      });
    }
  }
  return out;
}

function parseRequest(r: Json): DraRequest {
  // v1 / v1beta2: { exactly: {...} } or { firstAvailable: [...] }; v1beta1: the fields sit on the request itself.
  const exactly = r.exactly ? obj(r.exactly) : r;
  const first = arr(r.firstAvailable).map(obj);
  const classes = first.length > 0 ? first.map((s) => str(s.deviceClassName)) : [str(exactly.deviceClassName)];
  const single = first[0] ?? exactly;
  const mode = str(single.allocationMode) ?? "ExactCount";
  const count = mode === "ExactCount" ? Number(single.count ?? 1) || 1 : 1;
  return { name: str(r.name) ?? "", deviceClasses: classes.filter((c): c is string => !!c), count };
}

/** All ResourceClaims of a ResourceClaimList, with their requests, allocation and consuming pods. */
export function parseResourceClaims(list: unknown): DraClaim[] {
  return arr(obj(list).items).map((item) => {
    const it = obj(item);
    const meta = obj(it.metadata);
    const ns = str(meta.namespace) ?? "";
    const status = obj(it.status);
    const reserved = arr(status.reservedFor)
      .map(obj)
      .filter((r) => r.resource === "pods" && str(r.name))
      .map((r) => `${ns}/${r.name}`);
    const owners = arr(meta.ownerReferences)
      .map(obj)
      .filter((o) => o.kind === "Pod" && str(o.name))
      .map((o) => `${ns}/${o.name}`);
    return {
      namespace: ns,
      name: str(meta.name) ?? "",
      requests: arr(obj(obj(it.spec).devices).requests).map((r) => parseRequest(obj(r))),
      allocated: arr(obj(obj(status.allocation).devices).results)
        .map(obj)
        .map((r) => ({ driver: str(r.driver) ?? "", pool: str(r.pool) ?? "", device: str(r.device) ?? "" }))
        .filter((r) => r.driver && r.device),
      pods: reserved.length > 0 ? reserved : owners,
    };
  });
}

const deviceKey = (driver: string, pool: string, device: string) => `${driver}/${pool}/${device}`;

export interface DraIndex {
  /** GPU devices per node, from the ResourceSlices. */
  devicesByNode: Map<string, DraDevice[]>;
  /** GPU devices allocated to each pod ("ns/pod"). */
  podDevices: Map<string, DraDevice[]>;
  /** Claims by "ns/name", for the pending hints. */
  claims: Map<string, DraClaim>;
  /** Pods holding each device, by UUID (whole GPUs and MIG slices). */
  podsByUuid: Map<string, string[]>;
}

export function indexDra(state: DraState): DraIndex {
  const byKey = new Map(state.devices.map((d) => [deviceKey(d.driver, d.pool, d.name), d]));
  const devicesByNode = new Map<string, DraDevice[]>();
  for (const d of state.devices) devicesByNode.set(d.node, [...(devicesByNode.get(d.node) ?? []), d]);
  const podDevices = new Map<string, DraDevice[]>();
  const podsByUuid = new Map<string, string[]>();
  for (const c of state.claims) {
    const devs = c.allocated
      .map((r) => byKey.get(deviceKey(r.driver, r.pool, r.device)))
      .filter((d): d is DraDevice => !!d);
    if (devs.length === 0) continue;
    for (const pod of c.pods) {
      const held = podDevices.get(pod) ?? [];
      for (const d of devs) if (!held.includes(d)) held.push(d);
      podDevices.set(pod, held);
      for (const d of devs) {
        if (!d.uuid) continue;
        const pods = podsByUuid.get(d.uuid) ?? [];
        if (!pods.includes(pod)) pods.push(pod);
        podsByUuid.set(d.uuid, pods);
      }
    }
  }
  return {
    devicesByNode,
    podDevices,
    claims: new Map(state.claims.map((c) => [`${c.namespace}/${c.name}`, c])),
    podsByUuid,
  };
}

/** Resource name for a DRA device in the per-resource counts (Namespaces "Resources" column, pending requests). */
export function draResourceName(d: Pick<DraDevice, "type" | "profile" | "driver">): string {
  if (d.type === "mig" && d.profile) return `mig-${d.profile} (DRA)`;
  return `${d.type ?? d.driver} (DRA)`;
}

interface PodClaimsLike {
  spec?: { resourceClaims?: { name: string; resourceClaimName?: string; resourceClaimTemplateName?: string }[] };
  status?: { resourceClaimStatuses?: { name: string; resourceClaimName?: string }[] };
}

/**
 * The ResourceClaims a pod uses: the named ones (resourceClaimName), and the ones generated from a template, whose
 * name is in status.resourceClaimStatuses once the pod was processed. A template claim not generated yet is skipped.
 */
export function podClaimNames(pod: PodClaimsLike): string[] {
  const generated = new Map((pod.status?.resourceClaimStatuses ?? []).map((s) => [s.name, s.resourceClaimName]));
  return (pod.spec?.resourceClaims ?? [])
    .map((c) => c.resourceClaimName ?? generated.get(c.name))
    .filter((n): n is string => !!n);
}

/** A pod references DRA claims at all (spec.resourceClaims), whatever their state. */
export function podUsesDra(pod: PodClaimsLike): boolean {
  return (pod.spec?.resourceClaims ?? []).length > 0;
}

/** Unallocated GPU claims of a pod, for the Pending view. */
export function pendingGpuClaims(pod: PodClaimsLike & { metadata?: { namespace?: string } }, ix: DraIndex): DraClaim[] {
  const ns = pod.metadata?.namespace ?? "";
  return podClaimNames(pod)
    .map((n) => ix.claims.get(`${ns}/${n}`))
    .filter(
      (c): c is DraClaim =>
        !!c && c.allocated.length === 0 && c.requests.some((r) => r.deviceClasses.some(isGpuDeviceClass)),
    );
}

/** Device type a well-known NVIDIA device class selects, to compare a request with the devices on offer. */
const CLASS_TYPE: Record<string, string> = { "gpu.nvidia.com": "gpu", "mig.nvidia.com": "mig" };

/**
 * Hints for the unallocated DRA claims of a pending pod, only for requests that can never be satisfied as written:
 * no ResourceSlice offers the device type, or the claim asks for more devices than any node has. A claim that is
 * just waiting for busy devices gets no hint (the scheduler message says so). Only the well-known NVIDIA classes are
 * checked; for other classes the selector is not evaluated, so nothing is claimed about them.
 */
export function explainPendingClaims(claims: DraClaim[], ix: DraIndex): string[] {
  const hints: string[] = [];
  for (const c of claims) {
    for (const r of c.requests) {
      const types = r.deviceClasses.map((k) => CLASS_TYPE[k]);
      if (types.length === 0 || types.some((t) => !t)) continue;
      const perNode = [...ix.devicesByNode.values()].map((ds) => ds.filter((d) => types.includes(d.type ?? "")).length);
      const max = Math.max(0, ...perNode);
      const what = types.join(" or ");
      if (max === 0) hints.push(`No node publishes a ${what} device in a DRA ResourceSlice (claim ${c.name}).`);
      else if (r.count > max)
        hints.push(`Needs ${r.count} ${what} on one node (claim ${c.name}); the most any node offers is ${max}.`);
    }
  }
  return hints;
}

/** Short label for the device classes of a DRA request: "gpu (DRA)" for gpu.nvidia.com, as in the Namespaces view. */
export function draRequestLabel(deviceClasses: string[]): string {
  return `${deviceClasses.map((k) => CLASS_TYPE[k] ?? k).join(" | ")} (DRA)`;
}

/** Pods holding a card (by GPU UUID), directly or through one of its MIG slices. */
export function podsOnCard(ix: DraIndex, uuid: string): string[] {
  const out = new Set(ix.podsByUuid.get(uuid) ?? []);
  for (const [pod, devs] of ix.podDevices) if (devs.some((d) => d.parentUuid === uuid)) out.add(pod);
  return [...out].sort();
}
