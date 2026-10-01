import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregateByPod, aggregateDevicesDcgm, extractDcgmSamples } from "../aggregate";
import { parsePrometheusText } from "../prom";
import { type ReportInput, reportJson, reportMarkdown } from "../report";

const dgx = parsePrometheusText(readFileSync(join(__dirname, "fixtures", "dgx_a100_mig_mixed.prom"), "utf8"));

const base = (): ReportInput => ({
  cluster: "dgx",
  extensionVersion: "0.6.0",
  scrapedAt: new Date("2026-09-26T10:00:00Z"),
  exporters: [{ namespace: "gpu-operator", name: "dcgm-x", port: 9400, nodeName: "dgx-1", kind: "dcgm" }],
  devices: aggregateDevicesDcgm(dgx, "dgx-1"),
  pods: aggregateByPod(extractDcgmSamples(dgx, "dgx-1")),
  allocation: [
    {
      node: "dgx-1",
      capacity: 48,
      allocatable: 48,
      unhealthy: 0,
      requested: 29,
      requestingPods: [],
      migFree: [{ profile: "1g.10gb", free: 18, total: 46 }],
      devices: 48,
      busyDevices: 29,
      avgUtilPct: 0,
      vramUsedMiB: 0,
      vramTotalMiB: 0,
      powerWatts: 805,
    },
  ],
  namespaces: [],
  idle: [],
  pending: [],
});

describe("report", () => {
  it("renders the real DGX capture as readable Markdown", () => {
    const md = reportMarkdown(base());
    expect(md).toContain("### GPU snapshot · dgx");
    expect(md).toContain("48 devices · 29 GPU pods");
    expect(md).toContain("805 W");
    expect(md).toContain("No issues reported."); // GPU 4 reports remap state OK
    expect(md).toContain("| dgx-1 |  | 48 | 29 | 0 | 1g.10gb 18/46 | 0% |");
    expect(md).not.toContain("Waiting for a GPU"); // section only when something waits
  });

  it("puts health problems and waiting pods first, and escapes table cells", () => {
    const r = base();
    const d07 = r.devices.find((d) => d.gpu === "0:7");
    if (!d07) throw new Error("fixture has no 0:7");
    r.devices = [{ ...d07, lastXid: 79 }];
    r.allocation[0].unhealthy = 1;
    r.pending = [{ namespace: "ml", pod: "a|b", requests: { "nvidia.com/gpu": 1 }, hints: ["No node offers gpu."] }];
    const md = reportMarkdown(r);
    expect(md).toContain("🔴 dgx-1 GPU 0:7: last XID 79");
    expect(md).toContain("🔴 dgx-1: 1 device(s) withdrawn");
    expect(md).toContain("| ml/a\\|b | gpu×1 | No node offers gpu. |");
    expect(md.indexOf("**Health**")).toBeLessThan(md.indexOf("**Pods**"));
  });

  it("says when no health data is exported instead of claiming all is well", () => {
    const r = base();
    r.devices = r.devices.filter((d) => d.migProfile); // MIG slices carry no health gauges
    expect(reportMarkdown(r)).toContain("No health data exported");
  });

  it("emits parseable JSON with per-device health", () => {
    const j = JSON.parse(reportJson(base()));
    expect(j.scrapedAt).toBe("2026-09-26T10:00:00.000Z");
    expect(j.devices).toHaveLength(48);
    expect(j.devices.find((d: { gpu: string }) => d.gpu === "4").health).toEqual({ level: "ok", text: "OK" });
  });
});
