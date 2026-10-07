import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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

describe("helpers", () => {
  it("tells GPU device classes from the ComputeDomain ones", () => {
    expect(isGpuDeviceClass("gpu.nvidia.com")).toBe(true);
    expect(isGpuDeviceClass("mig.nvidia.com")).toBe(true);
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
