import { describe, expect, it } from "vitest";
import { scrapeStatus } from "../status";

import type { Snapshot } from "../types";

const at = new Date("2026-10-02T20:15:47");
const snap = {
  scrapedAt: at,
  mode: "pod",
  rows: [],
  gpus: [],
  exporters: [
    { namespace: "gpu-operator", name: "dcgm-a", port: 9400, nodeName: "n1", kind: "dcgm" },
    { namespace: "gpu-operator", name: "dcgm-b", port: 9400, nodeName: "n2", kind: "dcgm" },
  ],
} as unknown as Snapshot;

describe("scrapeStatus", () => {
  it("counts the exporters of a good scrape", () => {
    expect(scrapeStatus(snap, undefined, false)).toEqual({
      text: `2 exporters (dcgm) · last scrape ${at.toLocaleTimeString()}`,
      stale: false,
    });
  });

  it("says the rows are old when the latest scrape failed, without the exporter count", () => {
    const s = scrapeStatus(snap, "No GPU metrics exporter found", false);
    expect(s.stale).toBe(true);
    expect(s.text).toBe(`stale: last good scrape ${at.toLocaleTimeString()}, the latest one failed`);
    expect(s.text).not.toMatch(/exporter/);
  });

  it("has nothing stale before the first good scrape", () => {
    expect(scrapeStatus(undefined, "boom", false)).toEqual({ text: "", stale: false });
    expect(scrapeStatus(undefined, undefined, true)).toEqual({ text: "discovering exporters…", stale: false });
  });
});
