import { describe, expect, it } from "vitest";
import { nodeAdvertisesGpu, podMayUseGpu } from "../presence";

describe("podMayUseGpu", () => {
  it("is true for GPU, MIG and time-sliced requests, in limits or requests", () => {
    expect(podMayUseGpu([{ resources: { limits: { "nvidia.com/gpu": "1" } } }])).toBe(true);
    expect(podMayUseGpu([{ resources: { requests: { "nvidia.com/mig-1g.10gb": "1" } } }])).toBe(true);
    expect(podMayUseGpu([{}, { resources: { limits: { "nvidia.com/gpu.shared": "1" } } }])).toBe(true);
  });

  it("is true for pods that bypass the device plugin with NVIDIA_VISIBLE_DEVICES", () => {
    expect(podMayUseGpu([{ env: [{ name: "NVIDIA_VISIBLE_DEVICES", value: "all" }] }])).toBe(true);
    expect(podMayUseGpu([{ env: [{ name: "NVIDIA_VISIBLE_DEVICES", value: "GPU-1234" }] }])).toBe(true);
  });

  it("is false for ordinary pods and for NVIDIA_VISIBLE_DEVICES set to none or void", () => {
    expect(podMayUseGpu([{ resources: { limits: { cpu: "1", memory: "1Gi" } } }])).toBe(false);
    expect(podMayUseGpu([{ resources: { limits: { "nvidia.com/gpu": "0" } } }])).toBe(false);
    expect(podMayUseGpu([{ env: [{ name: "NVIDIA_VISIBLE_DEVICES", value: "void" }] }])).toBe(false);
    expect(podMayUseGpu([{ env: [{ name: "NVIDIA_VISIBLE_DEVICES", value: "none" }] }])).toBe(false);
    expect(podMayUseGpu([])).toBe(false);
  });
});

describe("nodeAdvertisesGpu", () => {
  it("is true when the capacity lists a GPU resource, even with zero devices", () => {
    expect(nodeAdvertisesGpu({ cpu: "8", "nvidia.com/gpu": "8" })).toBe(true);
    expect(nodeAdvertisesGpu({ "nvidia.com/mig-3g.40gb": "2" })).toBe(true);
    expect(nodeAdvertisesGpu({ "nvidia.com/gpu": "0" })).toBe(true);
  });

  it("is false for nodes without GPU resources", () => {
    expect(nodeAdvertisesGpu({ cpu: "8", memory: "32Gi", pods: "110" })).toBe(false);
    expect(nodeAdvertisesGpu(undefined)).toBe(false);
  });
});
