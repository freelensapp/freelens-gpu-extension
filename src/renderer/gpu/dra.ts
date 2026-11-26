/**
 * GPUs allocated with Dynamic Resource Allocation (resource.k8s.io). On DRA nodes a pod holds a GPU through a
 * ResourceClaim instead of a device-plugin count (nvidia.com/gpu or amd.com/gpu), so node capacity and container
 * limits miss it. This module reads the DRA objects:
 *
 * - ResourceSlice: the devices of a driver on a node (gpu-0, gpu-0-mig-1g10gb-19-0, gpu-56-184) with their attributes;
 * - ResourceClaim: the devices allocated to a claim (status.allocation.devices.results) and the pods using it
 *   (status.reservedFor, or the owner pod of a claim generated from a template).
 *
 * Pure functions over the JSON of the list endpoints, for resource.k8s.io/v1 and the v1beta2 / v1beta1 shapes of
 * Kubernetes 1.32 and 1.33 (v1beta1 wraps a device in "basic" and puts deviceClassName directly on the request).
 */

/** DRA drivers whose devices are GPUs: NVIDIA (whole GPUs and MIG) and AMD (whole GPUs and compute partitions). */
export const DRA_GPU_DRIVERS: ReadonlySet<string> = new Set(["gpu.nvidia.com", "gpu.amd.com"]);

/** Device classes that select GPUs: gpu.nvidia.com, mig.nvidia.com and gpu.amd.com (not ComputeDomain). */
export function isGpuDeviceClass(name: string): boolean {
  if (name === "gpu.amd.com") return true;
  return /(^|\.)nvidia\.com$/.test(name) && !/compute-domain/.test(name);
}

export interface DraDevice {
  node: string;
  driver: string;
  pool: string;
  /** Device name within the pool, e.g. "gpu-0", "gpu-2-mig-1g10gb-19-0" or "gpu-56-184". */
  name: string;
  /** "gpu" / "mig" (NVIDIA) or "amdgpu" / "amdgpu-partition" (AMD). */
  type?: string;
  /**
   * Device identity for podsOnCard / metrics join: NVIDIA uuid, or the AMD deviceID when uuid is absent. When several
   * devices of a node share one deviceID (the PCI id of the model) it is the PCI address of the card instead.
   */
  uuid?: string;
  /** Parent card of a MIG slice (parentUUID) or of an AMD partition (parentDeviceID). */
  parentUuid?: string;
  product?: string;
  /** MIG profile (e.g. "1g.10gb") or AMD partitionProfile (e.g. "cpx_nps1"). */
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
  /** What the identity was derived from, to tell a deviceID that names a card from one that names a model. */
  const derived: { dev: DraDevice; deviceID: string; pci?: string; parentUuidAttr?: string }[] = [];
  for (const item of arr(obj(list).items)) {
    const spec = obj(obj(item).spec);
    const driver = str(spec.driver);
    const node = str(spec.nodeName);
    if (!driver || !node || !DRA_GPU_DRIVERS.has(driver)) continue;
    const pool = str(obj(spec.pool).name) ?? node;
    for (const d of arr(spec.devices)) {
      const raw = obj(d);
      const name = str(raw.name);
      if (!name) continue;
      const body = raw.basic ? obj(raw.basic) : raw; // v1beta1 wraps attributes and capacity in "basic"
      const attrs = obj(body.attributes);
      const capacity = obj(body.capacity);
      const memory = obj(capacity.memory ?? capacity[`${driver}/memory`]);
      const explicitUuid = attr(attrs, "uuid", driver);
      const deviceID = attr(attrs, "deviceID", driver);
      const dev: DraDevice = {
        node,
        driver,
        pool,
        name,
        type: attr(attrs, "type", driver),
        // NVIDIA publishes uuid; AMD publishes deviceID without a uuid attribute. Older AMD drivers made it a per-card
        // id; newer ones publish the PCI device id of the model, shared by every card (see the pass below).
        uuid: explicitUuid ?? deviceID,
        parentUuid: attr(attrs, "parentUUID", driver) ?? attr(attrs, "parentDeviceID", driver),
        product: attr(attrs, "productName", driver),
        // NVIDIA MIG uses profile; AMD compute partitions use partitionProfile.
        profile: attr(attrs, "profile", driver) ?? attr(attrs, "partitionProfile", driver),
        memoryMiB: quantityMiB(str(memory.value)),
      };
      out.push(dev);
      if (!explicitUuid && deviceID) {
        derived.push({
          dev,
          deviceID,
          // The standard device attribute, or the older AMD driver's own name for it.
          pci: attr(attrs, "resource.kubernetes.io/pciBusID", driver) ?? attr(attrs, "pciAddr", driver),
          parentUuidAttr: attr(attrs, "parentUUID", driver),
        });
      }
    }
  }
  // A deviceID shared by several devices of a node names a model, not a card: eight MI300X would collapse into one
  // identity and every pod would be listed on all of them. The PCI address of the card tells them apart; a partition
  // takes its own name too, because it shares the address of the card it belongs to.
  const sharing = new Map<string, number>();
  const groupKey = (d: DraDevice, id: string) => `${d.node}\u0000${d.driver}\u0000${id}`;
  for (const m of derived) {
    const key = groupKey(m.dev, m.deviceID);
    sharing.set(key, (sharing.get(key) ?? 0) + 1);
  }
  for (const m of derived) {
    if ((sharing.get(groupKey(m.dev, m.deviceID)) ?? 0) < 2) continue;
    if (m.dev.type === "amdgpu-partition") {
      m.dev.uuid = `${m.pci ?? m.deviceID}/${m.dev.name}`;
      if (m.pci && !m.parentUuidAttr) m.dev.parentUuid = m.pci;
    } else {
      m.dev.uuid = m.pci ?? `${m.deviceID}/${m.dev.name}`;
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
  /** Pods holding each device, by UUID / deviceID (whole GPUs, MIG slices and AMD partitions). */
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
  if (d.type === "amdgpu-partition" && d.profile) return `amdgpu-partition-${d.profile} (DRA)`;
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

/**
 * Device types a well-known GPU device class selects, to compare a request with the devices on offer.
 * AMD's gpu.amd.com covers both full GPUs and compute partitions.
 */
export function typesForDeviceClass(name: string): string[] | undefined {
  switch (name) {
    case "gpu.nvidia.com":
      return ["gpu"];
    case "mig.nvidia.com":
      return ["mig"];
    case "gpu.amd.com":
      return ["amdgpu", "amdgpu-partition"];
    default:
      return undefined;
  }
}

/** Short label for a well-known device class in Pending / Namespaces. */
export function labelForDeviceClass(name: string): string {
  switch (name) {
    case "gpu.nvidia.com":
      return "gpu";
    case "mig.nvidia.com":
      return "mig";
    case "gpu.amd.com":
      return "amdgpu";
    default:
      return name;
  }
}

/**
 * Hints for the unallocated DRA claims of a pending pod, only for requests that can never be satisfied as written:
 * no ResourceSlice offers the device type, or the claim asks for more devices than any node has. A claim that is
 * just waiting for busy devices gets no hint (the scheduler message says so). Only the well-known NVIDIA and AMD
 * classes are checked; for other classes the selector is not evaluated, so nothing is claimed about them.
 */
export function explainPendingClaims(claims: DraClaim[], ix: DraIndex): string[] {
  const hints: string[] = [];
  for (const c of claims) {
    for (const r of c.requests) {
      const perClass = r.deviceClasses.map((k) => typesForDeviceClass(k));
      if (perClass.length === 0 || perClass.some((t) => !t)) continue;
      const types = [...new Set(perClass.flatMap((t) => t as string[]))];
      const perNode = [...ix.devicesByNode.values()].map((ds) => ds.filter((d) => types.includes(d.type ?? "")).length);
      const max = Math.max(0, ...perNode);
      const what = r.deviceClasses.map(labelForDeviceClass).join(" or ");
      if (max === 0) hints.push(`No node publishes a ${what} device in a DRA ResourceSlice (claim ${c.name}).`);
      else if (r.count > max)
        hints.push(`Needs ${r.count} ${what} on one node (claim ${c.name}); the most any node offers is ${max}.`);
    }
  }
  return hints;
}

/** Short label for the device classes of a DRA request: "gpu (DRA)" for gpu.nvidia.com, as in the Namespaces view. */
export function draRequestLabel(deviceClasses: string[]): string {
  return `${deviceClasses.map(labelForDeviceClass).join(" | ")} (DRA)`;
}

/** Pods holding a card (by GPU UUID / deviceID), directly or through one of its MIG slices / AMD partitions. */
export function podsOnCard(ix: DraIndex, uuid: string): string[] {
  const out = new Set(ix.podsByUuid.get(uuid) ?? []);
  for (const [pod, devs] of ix.podDevices) if (devs.some((d) => d.parentUuid === uuid)) out.add(pod);
  return [...out].sort();
}
