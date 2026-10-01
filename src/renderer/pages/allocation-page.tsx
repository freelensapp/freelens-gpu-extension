import { observer } from "mobx-react";
import { type Column, DataGrid } from "../components/data-grid";
import { nodeLink } from "../components/links";
import { PageShell } from "../components/page-shell";
import { fmtMiB } from "../components/styles";
import { UtilBar } from "../components/util-bar";
import { nodeHealth } from "../gpu/aggregate";
import { gpuStore } from "../gpu/store";

import type { Renderer } from "@freelensapp/extensions";

import type { AllocationRow } from "../gpu/types";

const ALLOC_COLUMNS: Column<AllocationRow>[] = [
  { key: "node", link: (r) => nodeLink(r.node), title: "Node", width: 240, min: 80, value: (r) => r.node },
  {
    key: "type",
    title: "GPU type",
    width: 200,
    min: 80,
    value: (r) => r.gpuType ?? "",
    className: "gpuext-dim",
    groupOf: (r) => r.gpuType ?? "",
  },
  {
    key: "capacity",
    title: "Capacity",
    width: 90,
    min: 60,
    num: true,
    value: (r) => r.capacity,
    title_: () => "nvidia.com/gpu in node status.capacity",
  },
  { key: "allocatable", title: "Allocatable", width: 100, min: 60, num: true, value: (r) => r.allocatable },
  {
    key: "health",
    title: "Health",
    width: 170,
    min: 70,
    value: (r) =>
      ({ bad: 0, warn: 1, unknown: 2, ok: 3 })[nodeHealth(gpuStore.devicesForNode(r.node), r.unhealthy).level],
    render: (r) => {
      const h = nodeHealth(gpuStore.devicesForNode(r.node), r.unhealthy);
      const icon = { bad: "●", warn: "●", ok: "●", unknown: "○" }[h.level];
      const cls = { bad: "gpuext-hot", warn: "gpuext-warn", ok: "gpuext-ok", unknown: "gpuext-dim" }[h.level];
      return (
        <span className={cls}>
          {icon} {h.text}
        </span>
      );
    },
    title_: (r) => nodeHealth(gpuStore.devicesForNode(r.node), r.unhealthy).text,
    groupOf: (r) => nodeHealth(gpuStore.devicesForNode(r.node), r.unhealthy).level,
  },
  {
    key: "unhealthy",
    title: "Unhealthy",
    width: 95,
    min: 60,
    num: true,
    value: (r) => r.unhealthy,
    render: (r) => <span className={r.unhealthy > 0 ? "gpuext-hot" : "gpuext-dim"}>{r.unhealthy}</span>,
    title_: (r) =>
      r.unhealthy > 0
        ? `${r.unhealthy} device(s) in capacity but not allocatable: the device plugin marked them unhealthy (XID, fallen off the bus) or they are reserved`
        : "capacity == allocatable",
  },
  {
    key: "requested",
    title: "Requested",
    width: 100,
    min: 60,
    num: true,
    value: (r) => r.requested,
    title_: (r) => r.requestingPods.join("\n") || "no running pod requests nvidia.com/gpu here",
  },
  {
    key: "free",
    title: "Unrequested",
    width: 100,
    min: 60,
    num: true,
    value: (r) => r.allocatable - r.requested,
    render: (r) => (
      <span className={r.allocatable - r.requested > 0 ? "gpuext-ok" : ""}>{r.allocatable - r.requested}</span>
    ),
  },
  {
    key: "migFree",
    title: "MIG free",
    width: 190,
    min: 70,
    value: (r) => (r.migFree ?? []).reduce((s, m) => s + m.free, 0),
    render: (r) =>
      r.migFree && r.migFree.length > 0 ? (
        <span className="gpuext-mono">
          {r.migFree.map((m, i) => (
            <span key={m.profile}>
              {i > 0 && " · "}
              <span className={m.free === 0 ? "gpuext-warn" : ""}>
                {m.profile} {m.free}/{m.total}
              </span>
            </span>
          ))}
        </span>
      ) : (
        <span className="gpuext-dim">–</span>
      ),
    title_: (r) =>
      r.migFree && r.migFree.length > 0
        ? `free MIG slices per profile (allocatable − requested by running pods): ${r.migFree.map((m) => `${m.profile} ${m.free} of ${m.total}`).join(", ")}`
        : "no MIG resources on this node",
  },
  {
    key: "devices",
    title: "Devices seen",
    width: 110,
    min: 60,
    num: true,
    value: (r) => r.devices,
    title_: () => "GPUs / MIG slices reported by an exporter on this node",
  },
  {
    key: "busy",
    title: "Busy",
    width: 70,
    min: 50,
    num: true,
    value: (r) => r.busyDevices,
    title_: () => "devices with a pod or ≥5% utilisation",
  },
  {
    key: "util",
    title: "Avg GPU %",
    width: 175,
    min: 90,
    value: (r) => r.avgUtilPct,
    title_: (r) => `${r.avgUtilPct.toFixed(1)}%`,
    render: (r) => (r.devices > 0 ? <UtilBar pct={r.avgUtilPct} /> : <span className="gpuext-dim">no exporter</span>),
  },
  {
    key: "vram",
    title: "VRAM used / total",
    width: 160,
    min: 80,
    num: true,
    value: (r) => r.vramUsedMiB,
    render: (r) => (r.devices > 0 ? `${fmtMiB(r.vramUsedMiB)} / ${fmtMiB(r.vramTotalMiB)}` : "–"),
  },
  {
    key: "power",
    title: "Power",
    width: 80,
    min: 50,
    num: true,
    value: (r) => r.powerWatts,
    render: (r) => (r.devices > 0 ? `${r.powerWatts.toFixed(0)} W` : "–"),
  },
];

export const AllocationPage = observer(({ extension }: { extension: Renderer.LensExtension }) => {
  const rows = gpuStore.allocation;
  const cap = rows.reduce((s, r) => s + r.allocatable, 0);
  const req = rows.reduce((s, r) => s + r.requested, 0);
  const busy = rows.reduce((s, r) => s + r.busyDevices, 0);
  const bad = rows.reduce((s, r) => s + r.unhealthy, 0);
  return (
    <PageShell
      extension={extension}
      title="GPU allocation by node"
      subtitle={
        <>
          What the scheduler thinks (<code>nvidia.com/gpu</code> capacity vs pod requests) next to what the exporters
          measure.
          {rows.length > 0 && (
            <>
              {" "}
              Cluster: {cap} allocatable, {req} requested, {busy} measured busy
              {bad > 0 && <span className="gpuext-hot">, {bad} unhealthy</span>}.
            </>
          )}
          {gpuStore.nodesError && <span className="gpuext-error"> Node list failed: {gpuStore.nodesError}</span>}
        </>
      }
    >
      <DataGrid
        id="allocation"
        columns={ALLOC_COLUMNS}
        rows={rows}
        rowKey={(r) => r.node}
        defaultSort={{ key: "node", dir: "asc" }}
        emptyText="No node advertises nvidia.com/gpu and no exporter reported devices."
      />
    </PageShell>
  );
});
