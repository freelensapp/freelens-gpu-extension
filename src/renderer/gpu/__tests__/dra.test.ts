import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  draResourceName,
  explainPendingClaims,
  indexDra,
  isGpuDeviceClass,
  parseResourceClaims,
  parseResourceSlices,
  pendingGpuClaims,
  podClaimNames,
  podsOnCard,
  quantityMiB,
} from "../dra";

// Captured from a Kubernetes 1.37 kind cluster with integration/fixtures/dra/objects.yaml applied: the scheduler
// allocated gpu-0 to trainer-0 and a MIG slice to notebook-0; big-job asks for 8 GPUs and stays pending.
const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));
const slices = fixture("dra_resourceslices_v1.json");
const claims = fixture("dra_resourceclaims_v1.json");
const pods = fixture("dra_pods_v1.json").items as { metadata: { namespace: string; name: string } }[];
const podNamed = (name: string) => pods.find((p) => p.metadata.name === name) as never;

describe("parseResourceSlices", () => {
  it("reads the GPU and MIG devices with their attributes", () => {
    const devs = parseResourceSlices(slices);
    expect(devs.map((d) => d.name)).toEqual(["gpu-0", "gpu-1", "gpu-2-mig-1g10gb-19-0", "gpu-2-mig-1g10gb-19-1"]);
    expect(devs[0]).toMatchObject({
      node: "dra-test-control-plane",
      driver: "gpu.nvidia.com",
      type: "gpu",
      uuid: "GPU-11111111-2222-3333-4444-555555555555",
      product: "NVIDIA H100 80GB HBM3",
      memoryMiB: 80 * 1024,
    });
    expect(devs[2]).toMatchObject({
      type: "mig",
      profile: "1g.10gb",
      parentUuid: "GPU-abababab-cdcd-efef-0101-232323232323",
      memoryMiB: 9728,
    });
  });

  it("ignores drivers that are not GPU drivers", () => {
    const other = {
      items: [{ spec: { driver: "compute-domain.nvidia.com", nodeName: "n", devices: [{ name: "x" }] } }],
    };
    expect(parseResourceSlices(other)).toEqual([]);
  });

  it("reads the v1beta1 shape (attributes under basic) and attributes qualified with the driver domain", () => {
    const beta = {
      items: [
        {
          spec: {
            driver: "gpu.nvidia.com",
            nodeName: "n1",
            pool: { name: "n1" },
            devices: [
              {
                name: "gpu-0",
                basic: {
                  attributes: { "gpu.nvidia.com/uuid": { string: "GPU-x" }, type: { string: "gpu" } },
                  capacity: { memory: { value: "40Gi" } },
                },
              },
            ],
          },
        },
      ],
    };
    expect(parseResourceSlices(beta)).toEqual([
      expect.objectContaining({ name: "gpu-0", uuid: "GPU-x", type: "gpu", memoryMiB: 40 * 1024 }),
    ]);
  });
});

describe("parseResourceClaims", () => {
  it("reads requests, allocation and the consuming pod", () => {
    const cs = parseResourceClaims(claims);
    const big = cs.find((c) => c.name === "eight-gpus");
    expect(big).toMatchObject({ allocated: [], pods: [], requests: [{ deviceClasses: ["gpu.nvidia.com"], count: 8 }] });
    const trainer = cs.find((c) => c.pods.includes("dra-ml/trainer-0"));
    expect(trainer?.allocated).toEqual([{ driver: "gpu.nvidia.com", pool: "dra-test-control-plane", device: "gpu-0" }]);
  });

  it("reads v1beta1 requests (deviceClassName on the request) and firstAvailable alternatives", () => {
    const cs = parseResourceClaims({
      items: [
        {
          metadata: { namespace: "a", name: "c1" },
          spec: {
            devices: {
              requests: [
                { name: "old", deviceClassName: "gpu.nvidia.com", allocationMode: "ExactCount", count: 2 },
                {
                  name: "alt",
                  firstAvailable: [{ deviceClassName: "mig.nvidia.com" }, { deviceClassName: "gpu.nvidia.com" }],
                },
              ],
            },
          },
        },
      ],
    });
    expect(cs[0].requests).toEqual([
      { name: "old", deviceClasses: ["gpu.nvidia.com"], count: 2 },
      { name: "alt", deviceClasses: ["mig.nvidia.com", "gpu.nvidia.com"], count: 1 },
    ]);
  });
});

describe("indexDra", () => {
  const ix = indexDra({ devices: parseResourceSlices(slices), claims: parseResourceClaims(claims) });

  it("maps pods to the devices allocated to their claims", () => {
    expect(ix.podDevices.get("dra-ml/trainer-0")?.map((d) => d.name)).toEqual(["gpu-0"]);
    expect(ix.podDevices.get("dra-ml/notebook-0")?.map((d) => d.name)).toEqual(["gpu-2-mig-1g10gb-19-0"]);
    expect(ix.podDevices.has("dra-ml/big-job")).toBe(false);
    expect(ix.devicesByNode.get("dra-test-control-plane")).toHaveLength(4);
  });

  it("finds the pods on a card by UUID, also through its MIG slices", () => {
    expect(podsOnCard(ix, "GPU-11111111-2222-3333-4444-555555555555")).toEqual(["dra-ml/trainer-0"]);
    expect(podsOnCard(ix, "GPU-abababab-cdcd-efef-0101-232323232323")).toEqual(["dra-ml/notebook-0"]);
    expect(podsOnCard(ix, "GPU-66666666-7777-8888-9999-000000000000")).toEqual([]);
  });

  it("names a pod's claims, generated or by name, and explains the pending one", () => {
    expect(podClaimNames(podNamed("big-job"))).toEqual(["eight-gpus"]);
    expect(podClaimNames(podNamed("trainer-0"))[0]).toMatch(/^trainer-0-gpu-/);
    expect(pendingGpuClaims(podNamed("trainer-0"), ix)).toEqual([]);
    const pending = pendingGpuClaims(podNamed("big-job"), ix);
    expect(pending.map((c) => c.name)).toEqual(["eight-gpus"]);
    expect(explainPendingClaims(pending, ix)).toEqual([
      "Needs 8 gpu on one node (claim eight-gpus); the most any node offers is 2.",
    ]);
  });

  it("gives no hint for a claim that only waits for busy devices, or for a class it cannot evaluate", () => {
    const claim = (deviceClasses: string[], count: number) => ({
      namespace: "a",
      name: "c",
      requests: [{ name: "r", deviceClasses, count }],
      allocated: [],
      pods: [],
    });
    expect(explainPendingClaims([claim(["gpu.nvidia.com"], 1)], ix)).toEqual([]);
    expect(explainPendingClaims([claim(["gpu.example.com"], 99)], ix)).toEqual([]);
    const noMig = indexDra({ devices: parseResourceSlices(slices).filter((d) => d.type !== "mig"), claims: [] });
    expect(explainPendingClaims([claim(["mig.nvidia.com"], 1)], noMig)).toEqual([
      "No node publishes a mig device in a DRA ResourceSlice (claim c).",
    ]);
  });
});

describe("AMD DRA (gpu.amd.com)", () => {
  const amdSlices = fixture("dra_amd_resourceslices_v1.json");
  const amdClaims = fixture("dra_amd_resourceclaims_v1.json");

  it("reads AMD GPUs and partitions with deviceID, parentDeviceID and partitionProfile", () => {
    const devs = parseResourceSlices(amdSlices);
    expect(devs.map((d) => d.name)).toEqual(["gpu-56-184", "gpu-4-132", "gpu-48-176"]);
    expect(devs[0]).toMatchObject({
      node: "gpu-worker-2",
      driver: "gpu.amd.com",
      type: "amdgpu",
      uuid: "8462659767828489944",
      product: "AMD_Instinct_MI300X_OAM",
      profile: "spx_nps1",
      memoryMiB: 196592,
    });
    expect(devs[1]).toMatchObject({
      type: "amdgpu-partition",
      profile: "cpx_nps1",
      parentUuid: "16912319329091163297",
      memoryMiB: 24574,
    });
    expect(draResourceName(devs[0])).toBe("amdgpu (DRA)");
    expect(draResourceName(devs[1])).toBe("amdgpu-partition-cpx_nps1 (DRA)");
  });

  it("indexes allocated AMD claims and finds pods on a card through partitions", () => {
    const ix = indexDra({ devices: parseResourceSlices(amdSlices), claims: parseResourceClaims(amdClaims) });
    expect(ix.podDevices.get("gpu-test/pod1")?.map((d) => d.name)).toEqual(["gpu-56-184"]);
    expect(ix.podDevices.get("gpu-test/notebook")?.map((d) => d.name)).toEqual(["gpu-4-132"]);
    expect(podsOnCard(ix, "8462659767828489944")).toEqual(["gpu-test/pod1"]);
    expect(podsOnCard(ix, "16912319329091163297")).toEqual(["gpu-test/notebook"]);
  });

  describe("a node whose cards share one deviceID", () => {
    // Captured from 8x MI300X (driver 1.0.1, MI300X in SPX/NPS1): every card publishes deviceID 0x74a1, the PCI id of
    // the model. Two pods hold cards: one claim for one GPU, one claim for two.
    const mi300x = parseResourceSlices(fixture("dra_amd_mi300x_8gpu_resourceslices_v1.json"));
    const mi300xClaims = parseResourceClaims(fixture("dra_amd_mi300x_8gpu_resourceclaims_v1.json"));
    const card = (name: string) => mi300x.find((d) => d.name === name)?.uuid ?? "";

    it("tells the eight cards apart by their PCI address", () => {
      expect(mi300x).toHaveLength(8);
      expect(new Set(mi300x.map((d) => d.uuid)).size).toBe(8);
      expect(mi300x.every((d) => /^[0-9a-f]{4}:[0-9a-f]{2}:00\.0$/.test(d.uuid ?? ""))).toBe(true);
      expect(mi300x.every((d) => d.product === "AMD_Instinct_MI300X_OAM" && d.memoryMiB === 196592)).toBe(true);
    });

    it("lists each pod only on the cards its claim was allocated", () => {
      const ix = indexDra({ devices: mi300x, claims: mi300xClaims });
      expect(podsOnCard(ix, card("gpu-57-184"))).toEqual(["dra-test/holder-1gpu"]);
      expect(podsOnCard(ix, card("gpu-1-128"))).toEqual(["dra-test/holder-2gpu"]);
      expect(podsOnCard(ix, card("gpu-9-136"))).toEqual(["dra-test/holder-2gpu"]);
      expect(podsOnCard(ix, card("gpu-17-144"))).toEqual([]);
    });

    it("tells the 8 partitions of a CPX card apart (live capture, GPU 7 in CPX, GPUs 0 to 6 in SPX)", () => {
      const devs = parseResourceSlices(fixture("dra_amd_mi300x_cpx_resourceslices_v1.json"));
      const parts = devs.filter((d) => d.type === "amdgpu-partition");
      expect(devs).toHaveLength(15);
      expect(parts).toHaveLength(8);
      expect(parts.every((d) => d.profile === "cpx_nps1" && d.memoryMiB === 24574)).toBe(true);
      expect(new Set(devs.map((d) => d.uuid)).size).toBe(15);
      expect([...new Set(parts.map((d) => d.parentUuid))]).toEqual(["0000:da:00.0"]);
      const claims = parseResourceClaims(fixture("dra_amd_mi300x_cpx_resourceclaims_v1.json"));
      const ix = indexDra({ devices: devs, claims });
      expect(
        ix.podDevices
          .get("dra-test/load-2part")
          ?.map((d) => d.name)
          .sort(),
      ).toEqual(["gpu-62-189", "gpu-63-190"]);
      expect(podsOnCard(ix, "0000:da:00.0")).toEqual(["dra-test/load-2part"]);
      expect(podsOnCard(ix, "0000:c2:00.0")).toEqual([]);
    });

    it("gives a partition its own identity and links it to the card by PCI address", () => {
      const slice = (devices: unknown[]) => ({
        items: [{ spec: { driver: "gpu.amd.com", nodeName: "n1", pool: { name: "n1" }, devices } }],
      });
      const attrs = (type: string, pci: string) => ({
        type: { string: type },
        deviceID: { string: "0x74a1" },
        "resource.kubernetes.io/pciBusID": { string: pci },
        partitionProfile: { string: type === "amdgpu" ? "spx_nps1" : "cpx_nps1" },
      });
      const devs = parseResourceSlices(
        slice([
          { name: "gpu-1-128", attributes: attrs("amdgpu", "0000:11:00.0") },
          { name: "gpu-1-128-p0", attributes: attrs("amdgpu-partition", "0000:11:00.0") },
          { name: "gpu-1-128-p1", attributes: attrs("amdgpu-partition", "0000:11:00.0") },
          { name: "gpu-9-136", attributes: attrs("amdgpu", "0000:2f:00.0") },
        ]),
      );
      expect(devs.map((d) => d.uuid)).toEqual([
        "0000:11:00.0",
        "0000:11:00.0/gpu-1-128-p0",
        "0000:11:00.0/gpu-1-128-p1",
        "0000:2f:00.0",
      ]);
      expect(devs[1].parentUuid).toBe("0000:11:00.0");
      const claims = parseResourceClaims({
        items: [
          {
            metadata: { namespace: "ml", name: "c" },
            spec: { devices: { requests: [{ name: "g", exactly: { deviceClassName: "gpu.amd.com", count: 1 } }] } },
            status: {
              allocation: { devices: { results: [{ driver: "gpu.amd.com", pool: "n1", device: "gpu-1-128-p1" }] } },
              reservedFor: [{ resource: "pods", name: "trainer" }],
            },
          },
        ],
      });
      const ix = indexDra({ devices: devs, claims });
      expect(podsOnCard(ix, "0000:11:00.0")).toEqual(["ml/trainer"]);
      expect(podsOnCard(ix, "0000:2f:00.0")).toEqual([]);
    });
  });

  it("explains pending AMD claims against published amdgpu capacity", () => {
    const ix = indexDra({ devices: parseResourceSlices(amdSlices), claims: parseResourceClaims(amdClaims) });
    const pending = parseResourceClaims(amdClaims).filter((c) => c.name === "eight-amd-gpus");
    expect(explainPendingClaims(pending, ix)).toEqual([
      "Needs 8 amdgpu on one node (claim eight-amd-gpus); the most any node offers is 3.",
    ]);
    const one = { ...pending[0], requests: [{ name: "gpu", deviceClasses: ["gpu.amd.com"], count: 1 }] };
    expect(explainPendingClaims([one], ix)).toEqual([]);
  });
});

describe("helpers", () => {
  it("tells GPU device classes from the ComputeDomain ones", () => {
    expect(isGpuDeviceClass("gpu.nvidia.com")).toBe(true);
    expect(isGpuDeviceClass("mig.nvidia.com")).toBe(true);
    expect(isGpuDeviceClass("gpu.amd.com")).toBe(true);
    expect(isGpuDeviceClass("compute-domain-daemon.nvidia.com")).toBe(false);
    expect(isGpuDeviceClass("gpu.example.com")).toBe(false);
  });

  it("converts quantities to MiB", () => {
    expect(quantityMiB("80Gi")).toBe(81920);
    expect(quantityMiB("9728Mi")).toBe(9728);
    expect(quantityMiB("1073741824")).toBe(1024);
    expect(quantityMiB("lots")).toBeUndefined();
  });
});
