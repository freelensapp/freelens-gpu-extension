import { describe, expect, it } from "vitest";
import { explainPending, gpuRequestsOf, type NodeGpuResources, type PendingGpuPod } from "../pending";

// klabdgx node status, 2026-09-24: 1 whole GPU + 46 + 1 MIG slices (mig.strategy=mixed)
const dgx: NodeGpuResources = {
  name: "dgx",
  allocatable: {
    "nvidia.com/gpu": 1,
    "nvidia.com/mig-1g.10gb": 46,
    "nvidia.com/mig-1g.10gb.shared": 0,
    "nvidia.com/mig-3g.40gb": 1,
  },
};
const pod = (requests: Record<string, number>): PendingGpuPod => ({ namespace: "ml", pod: "p", requests });

describe("gpuRequestsOf", () => {
  it("sums GPU limits across containers, falling back to requests, ignoring cpu/memory", () => {
    expect(
      gpuRequestsOf([
        { resources: { limits: { "nvidia.com/mig-1g.10gb": "1", cpu: "2" } } },
        { resources: { requests: { "nvidia.com/mig-1g.10gb": "2" } } },
        { resources: { limits: { memory: "1Gi" } } },
        {},
      ]),
    ).toEqual({ "nvidia.com/mig-1g.10gb": 3 });
  });
});

describe("explainPending", () => {
  it("says nothing when the request can be met once devices free up", () => {
    expect(explainPending(pod({ "nvidia.com/mig-1g.10gb": 1 }), [dgx])).toEqual([]);
  });
  it("flags a resource no node offers and lists what the cluster has", () => {
    const [h] = explainPending(pod({ "nvidia.com/mig-2g.20gb": 1 }), [dgx]);
    expect(h).toContain("No node offers mig-2g.20gb.");
    expect(h).toContain("mig-1g.10gb ×46");
    expect(h).not.toContain(".shared"); // zero-count resources are not "offered"
  });
  it("points whole-GPU requests at MIG slices when a MIG node exists", () => {
    const [h] = explainPending(pod({ "nvidia.com/gpu": 1 }), [
      { name: "dgx", allocatable: { "nvidia.com/mig-1g.10gb": 46 } },
    ]);
    expect(h).toContain("No node offers gpu.");
    expect(h).toContain("request a slice such as nvidia.com/mig-1g.10gb");
  });
  it("does not suggest MIG slices when the MIG resources on the nodes are all zero", () => {
    const [h] = explainPending(pod({ "nvidia.com/gpu": 1 }), [
      { name: "n", allocatable: { "nvidia.com/mig-1g.10gb": 0, "nvidia.com/mig-1g.10gb.shared": 0 } },
    ]);
    expect(h).toBe("No node offers gpu.");
  });
  it("flags more devices than any single node has", () => {
    expect(
      explainPending(pod({ "nvidia.com/gpu": 2 }), [dgx, { name: "b", allocatable: { "nvidia.com/gpu": 1 } }]),
    ).toEqual(["Needs 2 gpu on one node; the most any node has is 1."]);
  });
  it("handles a cluster with no GPU nodes at all", () => {
    expect(explainPending(pod({ "nvidia.com/gpu": 1 }), [{ name: "cpu-only", allocatable: {} }])).toEqual([
      "No node offers gpu.",
    ]);
  });
});
