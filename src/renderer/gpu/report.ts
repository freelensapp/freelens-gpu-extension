/**
 * "Copy snapshot": the current GPU state of the cluster as JSON (complete, for
 * tools) or Markdown (readable, for pasting into Slack / Jira during an incident).
 * Pure function over what the store already computed.
 */

import { deviceHealth, totalPowerW } from "./aggregate";

import type { VllmRates, VllmSample } from "./inference";
import type { NamespaceRow } from "./namespaces";
import type { AllocationRow, ExporterScrape, GpuDevice, IdleRow, PendingGpuPod, PodGPU } from "./types";

export interface ReportInput {
  cluster?: string;
  extensionVersion?: string;
  scrapedAt?: Date;
  error?: string;
  exporters: ExporterScrape[];
  devices: GpuDevice[];
  pods: PodGPU[];
  allocation: AllocationRow[];
  namespaces: NamespaceRow[];
  idle: IdleRow[];
  pending: (PendingGpuPod & { hints?: string[] })[];
  /** Inference servers (vLLM) with their serving numbers. */
  inference?: {
    namespace: string;
    pod: string;
    engine: string;
    sample?: VllmSample;
    rates: VllmRates;
    status: { level: string; text: string };
  }[];
}

const mib = (v: number) => (v >= 1024 ? `${(v / 1024).toFixed(1)} GiB` : `${Math.round(v)} MiB`);
const pct = (v?: number) => (v === undefined ? "–" : `${v.toFixed(0)}%`);
/** Markdown table cell: no pipes or newlines. */
const cell = (v: string | number) => String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");

function table(head: string[], rows: (string | number)[][]): string {
  if (rows.length === 0) return "_none_\n";
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");
}

export function reportJson(r: ReportInput): string {
  return JSON.stringify(
    {
      ...r,
      scrapedAt: r.scrapedAt?.toISOString(),
      devices: r.devices.map((d) => ({ ...d, health: deviceHealth(d) })),
    },
    null,
    2,
  );
}

export function reportMarkdown(r: ReportInput): string {
  const sick = r.devices
    .map((d) => ({ d, h: deviceHealth(d) }))
    .filter(({ h }) => h.level === "bad" || h.level === "warn");
  const unhealthyNodes = r.allocation.filter((a) => a.unhealthy > 0);
  const out: string[] = [];
  out.push(`### GPU snapshot${r.cluster ? ` · ${r.cluster}` : ""}`);
  out.push(
    [
      r.scrapedAt ? `scraped ${r.scrapedAt.toISOString()}` : "no metrics scrape",
      `${r.devices.length} devices`,
      `${r.pods.length} GPU pods`,
      `${mib(r.devices.reduce((s, d) => s + d.vramUsedMiB, 0))} / ${mib(r.devices.reduce((s, d) => s + d.vramTotalMiB, 0))} VRAM`,
      `${totalPowerW(r.devices).toFixed(0)} W`,
      `${r.pending.length} waiting`,
      r.extensionVersion ? `freelens-gpu-extension v${r.extensionVersion}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  );
  if (r.error) out.push(`\n> ⚠️ ${r.error.split("\n")[0]}`);

  out.push("\n**Health**");
  if (sick.length === 0 && unhealthyNodes.length === 0) {
    out.push(
      r.devices.some((d) => deviceHealth(d).level === "ok")
        ? "No issues reported."
        : "No health data exported (XID/ECC/row-remap gauges missing).",
    );
  } else {
    for (const { d, h } of sick) out.push(`- ${h.level === "bad" ? "🔴" : "🟡"} ${d.node} GPU ${d.gpu}: ${h.text}`);
    for (const a of unhealthyNodes)
      out.push(`- 🔴 ${a.node}: ${a.unhealthy} device(s) withdrawn (capacity > allocatable)`);
  }

  if (r.pending.length > 0) {
    out.push("\n**Waiting for a GPU**");
    out.push(
      table(
        ["Pod", "Requests", "Why / scheduler"],
        r.pending.map((p) => [
          `${p.namespace}/${p.pod}`,
          Object.entries(p.requests)
            .map(([k, v]) => `${k.replace(/^nvidia\.com\//, "")}×${v}`)
            .join(", "),
          p.hints?.length ? p.hints.join(" ") : (p.message ?? p.reason ?? ""),
        ]),
      ),
    );
  }

  if (r.inference && r.inference.length > 0) {
    out.push("\n**Inference servers**");
    out.push(
      table(
        ["Pod", "Model", "KV cache", "Running", "Waiting", "Gen tok/s", "TTFT", "Status"],
        r.inference.map((i) => [
          `${i.namespace}/${i.pod}`,
          i.sample?.models.join(", ") || i.engine,
          i.sample?.kvCachePct === undefined ? "–" : pct(i.sample.kvCachePct),
          i.sample?.running ?? "–",
          i.sample?.waiting ?? "–",
          i.rates.generationTokPerSec === undefined ? "–" : i.rates.generationTokPerSec.toFixed(0),
          i.rates.ttftMs === undefined ? "–" : `${i.rates.ttftMs.toFixed(0)} ms`,
          i.status.text,
        ]),
      ),
    );
  }

  if (r.idle.length > 0) {
    out.push("\n**Idle GPU holders**");
    out.push(
      table(
        ["Pod", "Node", "GPU", "VRAM held", "Idle for"],
        r.idle.map((p) => [
          `${p.namespace}/${p.pod}`,
          p.node,
          p.gpus.join(","),
          mib(p.vramUsedMiB),
          `${p.idleMinutes.toFixed(0)} min`,
        ]),
      ),
    );
  }

  out.push("\n**Allocation**");
  out.push(
    table(
      ["Node", "GPU type", "Allocatable", "Requested", "Unhealthy", "MIG free", "Avg GPU %"],
      r.allocation.map((a) => [
        a.node,
        a.gpuType ?? "",
        a.allocatable,
        a.requested,
        a.unhealthy,
        (a.migFree ?? []).map((m) => `${m.profile} ${m.free}/${m.total}`).join(", ") || "–",
        a.devices > 0 ? pct(a.avgUtilPct) : "–",
      ]),
    ),
  );

  out.push("\n**Namespaces**");
  out.push(
    table(
      ["Namespace", "Requested", "In use", "Avg GPU %", "VRAM held", "Idle VRAM", "Waiting"],
      r.namespaces.map((n) => [
        n.namespace,
        n.requested,
        n.devicesInUse,
        n.devicesInUse > 0 ? pct(n.avgUtilPct) : "–",
        mib(n.vramUsedMiB),
        n.idlePods > 0 ? mib(n.idleVramMiB) : "–",
        n.pending,
      ]),
    ),
  );

  out.push("\n**Pods**");
  out.push(
    table(
      ["Pod", "Node", "GPU", "GPU %", "VRAM", "Power"],
      r.pods.map((p) => [
        p.gpuIndex ? `(gpu ${p.gpuIndex})` : `${p.namespace}/${p.pod}`,
        p.node,
        p.gpus.join(","),
        `${pct(p.gpuUtilPct)}${(p.sharedWith ?? 1) > 1 ? ` (shared ×${p.sharedWith})` : p.timeSliced ? " (time-sliced)" : ""}`,
        mib(p.vramUsedMiB),
        `${p.powerWatts.toFixed(0)} W`,
      ]),
    ),
  );

  out.push(`\n_Exporters: ${r.exporters.map((e) => `${e.namespace}/${e.name} (${e.kind})`).join(", ") || "none"}_`);
  return out.join("\n");
}
