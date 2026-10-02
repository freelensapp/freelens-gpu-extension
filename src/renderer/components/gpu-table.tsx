import React from "react";
import { gpuSortKey, physicalGPUGroup } from "../gpu/aggregate";
import { isFallback, type PodGPU, vramTotalMiB } from "../gpu/types";
import { type Column, DataGrid } from "./data-grid";
import { namespaceLink, nodeLink, podLink } from "./links";
import { fmtMiB } from "./styles";
import { UtilBar } from "./util-bar";

export interface GpuTableProps {
  rows: PodGPU[];
  /** Hide the namespace/pod/node columns when the context already implies them. */
  compact?: boolean;
  /** Hide only the node column (node drawer). */
  hideNode?: boolean;
}

const HealthDot = ({ r }: { r: PodGPU }) =>
  r.health && r.health.level !== "ok" ? (
    <span className={r.health.level === "bad" ? "gpuext-hot" : "gpuext-warn"} title={r.health.text}>
      ●{" "}
    </span>
  ) : null;

const GpuBadges = ({ r }: { r: PodGPU }) =>
  r.gpus.length > 0 ? (
    <>
      <HealthDot r={r} />
      {r.gpus.map((g) => (
        <span key={g} className="gpuext-badge gpuext-mono">
          {g}
        </span>
      ))}
    </>
  ) : (
    <span className="gpuext-dim">({r.gpuCount})</span>
  );

const hintOf = (r: PodGPU) => (isFallback(r) && r.hintPods && r.hintPods.length > 0 ? r.hintPods.join(", ") : "");

export const POD_COLUMNS: Column<PodGPU>[] = [
  {
    key: "namespace",
    link: (r) => (r.gpuIndex ? undefined : namespaceLink(r.namespace)),
    title: "Namespace",
    width: 130,
    flex: 100,
    min: 60,
    value: (r) => r.namespace,
    groupOf: (r) => r.namespace,
  },
  {
    key: "pod",
    link: (r) => (r.gpuIndex ? undefined : podLink(r.namespace, r.pod)),
    title: "Pod",
    width: 360,
    flex: 160,
    min: 80,
    value: (r) => r.pod,
    title_: (r) => (hintOf(r) ? `${r.pod} → ${hintOf(r)}` : r.pod),
    render: (r) => (
      <>
        {r.pod}
        {hintOf(r) && <span className="gpuext-dim"> → {hintOf(r)}</span>}
      </>
    ),
  },
  {
    key: "node",
    link: (r) => nodeLink(r.node),
    title: "Node",
    width: 200,
    flex: 140,
    min: 60,
    value: (r) => r.node,
    className: "gpuext-dim",
    groupOf: (r) => r.node,
  },
  {
    key: "gpu",
    title: "GPU",
    width: 90,
    min: 50,
    value: (r) => gpuSortKey(r),
    groupOf: physicalGPUGroup,
    title_: (r) =>
      r.health && r.health.level !== "ok" ? `${r.gpus.join(", ")} · ${r.health.text}` : r.gpus.join(", "),
    render: (r) => <GpuBadges r={r} />,
  },
  {
    key: "util",
    title: "GPU %",
    width: 230,
    min: 90,
    value: (r) => r.gpuUtilPct,
    title_: (r) =>
      (r.sharedWith ?? 1) > 1
        ? `${r.gpuUtilPct.toFixed(1)}% for the whole device, shared by ${r.sharedWith} pods; dcgm-exporter cannot split it per pod`
        : r.timeSliced
          ? `${r.gpuUtilPct.toFixed(1)}% for the whole device: the node time-slices its GPUs, so other pods may share it`
          : `${r.gpuUtilPct.toFixed(1)}%`,
    render: (r) => (
      <>
        <UtilBar pct={r.gpuUtilPct} />
        {(r.sharedWith ?? 1) > 1 ? (
          <span className="gpuext-badge gpuext-shared">shared ×{r.sharedWith}</span>
        ) : (
          r.timeSliced && <span className="gpuext-badge gpuext-shared">time-sliced</span>
        )}
      </>
    ),
  },
  {
    key: "power",
    title: "Power",
    width: 80,
    min: 50,
    num: true,
    value: (r) => r.powerWatts,
    render: (r) => `${r.powerWatts.toFixed(0)} W`,
  },
  {
    key: "vramUsed",
    title: "VRAM used",
    width: 100,
    min: 60,
    num: true,
    value: (r) => r.vramUsedMiB,
    render: (r) => fmtMiB(r.vramUsedMiB),
  },
  {
    key: "vramTotal",
    title: "VRAM total",
    width: 100,
    min: 60,
    num: true,
    value: (r) => vramTotalMiB(r),
    render: (r) => fmtMiB(vramTotalMiB(r)),
    className: "gpuext-dim",
  },
];

const COMPACT_HIDDEN = new Set(["namespace", "pod", "node"]);

export function GpuTable({ rows, compact, hideNode }: GpuTableProps) {
  const columns = React.useMemo(
    () =>
      compact
        ? POD_COLUMNS.filter((c) => !COMPACT_HIDDEN.has(c.key))
        : hideNode
          ? POD_COLUMNS.filter((c) => c.key !== "node")
          : POD_COLUMNS,
    [compact, hideNode],
  );
  return (
    <DataGrid
      id={compact ? "pods.compact" : hideNode ? "pods.node" : "pods.full"}
      columns={columns}
      rows={rows}
      rowKey={(r) => `${r.node}/${r.namespace}/${r.pod}/${r.gpus.join(",")}`}
      defaultSort={{ key: "gpu", dir: "asc" }}
      groupOf={physicalGPUGroup}
    />
  );
}
