import { observer } from "mobx-react";
import { type Column, DataGrid } from "../components/data-grid";
import { nodeLink, podRefLink } from "../components/links";
import { PageShell } from "../components/page-shell";
import { fmtMiB } from "../components/styles";
import { UtilBar } from "../components/util-bar";
import { deviceHealth, totalPowerW } from "../gpu/aggregate";
import { gpuStore } from "../gpu/store";

import type { Renderer } from "@freelensapp/extensions";

import type { GpuDevice } from "../gpu/types";

const gpuKey = (d: GpuDevice) =>
  `${d.node}/${d.gpu
    .split(":")
    .map((p) => p.padStart(3, "0"))
    .join(":")}`;

const tempClass = (t?: number) => (t === undefined ? "" : t >= 85 ? "gpuext-hot" : t >= 75 ? "gpuext-warn" : "");

export const DEVICE_COLUMNS: Column<GpuDevice>[] = [
  {
    key: "node",
    link: (d) => nodeLink(d.node),
    title: "Node",
    width: 220,
    min: 80,
    value: (d) => d.node,
    groupOf: (d) => d.node,
  },
  {
    key: "gpu",
    title: "GPU",
    width: 70,
    min: 50,
    value: (d) => gpuKey(d),
    title_: (d) => d.gpu,
    render: (d) => <span className="gpuext-badge gpuext-mono">{d.gpu}</span>,
  },
  {
    key: "model",
    title: "Model",
    width: 200,
    min: 80,
    value: (d) => d.model ?? "",
    className: "gpuext-dim",
    groupOf: (d) => d.model ?? "",
  },
  {
    key: "mig",
    title: "MIG profile",
    width: 100,
    min: 60,
    value: (d) => d.migProfile ?? "",
    className: "gpuext-mono",
    groupOf: (d) => d.migProfile ?? "",
  },
  {
    key: "util",
    title: "GPU %",
    width: 175,
    min: 90,
    value: (d) => d.utilPct,
    title_: (d) => `${d.utilPct.toFixed(1)}%`,
    render: (d) => <UtilBar pct={d.utilPct} />,
  },
  ...(
    [
      [
        "sm",
        "SM active",
        "smActivePct",
        "DCGM_FI_PROF_SM_ACTIVE: share of time at least one warp is resident on an SM",
      ],
      ["tensor", "Tensor", "tensorActivePct", "DCGM_FI_PROF_PIPE_TENSOR_ACTIVE: tensor (HMMA) pipe activity"],
      ["dram", "Mem BW", "dramActivePct", "DCGM_FI_PROF_DRAM_ACTIVE: device memory interface activity"],
    ] as const
  ).map(
    ([key, title, field, help]): Column<GpuDevice> => ({
      key,
      title,
      width: 85,
      min: 60,
      num: true,
      value: (d) => d[field] ?? -1,
      render: (d) => (d[field] === undefined ? "–" : `${(d[field] as number).toFixed(0)}%`),
      title_: (d) => (d[field] === undefined ? `${help} (not exported)` : help),
    }),
  ),
  {
    key: "vramUsed",
    title: "VRAM used",
    width: 100,
    min: 60,
    num: true,
    value: (d) => d.vramUsedMiB,
    render: (d) => fmtMiB(d.vramUsedMiB),
  },
  {
    key: "vramTotal",
    title: "VRAM total",
    width: 100,
    min: 60,
    num: true,
    value: (d) => d.vramTotalMiB,
    render: (d) => fmtMiB(d.vramTotalMiB),
    className: "gpuext-dim",
  },
  {
    key: "vramPct",
    title: "VRAM %",
    width: 80,
    min: 60,
    num: true,
    value: (d) => (d.vramTotalMiB > 0 ? (100 * d.vramUsedMiB) / d.vramTotalMiB : 0),
    render: (d) => (d.vramTotalMiB > 0 ? `${((100 * d.vramUsedMiB) / d.vramTotalMiB).toFixed(0)}%` : "–"),
  },
  {
    key: "power",
    title: "Power",
    width: 80,
    min: 50,
    num: true,
    value: (d) => d.powerWatts,
    render: (d) => `${d.powerWatts.toFixed(0)} W`,
    title_: (d) =>
      d.migProfile
        ? `${d.powerWatts.toFixed(0)} W is the whole card's draw (DCGM reports it on every slice); pods and namespaces are charged a share by slice size`
        : `${d.powerWatts.toFixed(0)} W`,
  },
  {
    key: "temp",
    title: "Temp",
    width: 70,
    min: 50,
    num: true,
    value: (d) => d.tempC ?? -1,
    render: (d) => (
      <span className={tempClass(d.tempC)}>{d.tempC === undefined ? "–" : `${d.tempC.toFixed(0)} °C`}</span>
    ),
  },
  {
    key: "health",
    title: "Health",
    width: 150,
    min: 70,
    value: (d) => ({ bad: 0, warn: 1, unknown: 2, ok: 3 })[deviceHealth(d).level],
    render: (d) => {
      const h = deviceHealth(d);
      const cls = { bad: "gpuext-hot", warn: "gpuext-warn", ok: "gpuext-ok", unknown: "gpuext-dim" }[h.level];
      return <span className={cls}>{h.text}</span>;
    },
    title_: (d) => {
      const h = deviceHealth(d);
      return h.level === "unknown"
        ? "dcgm-exporter reports no health gauges for this device (MIG slices never carry them; XID/ECC may be missing from the counters CSV)"
        : `DCGM_FI_DEV_XID_ERRORS / ECC_DBE_VOL_TOTAL / ROW_REMAP_FAILURE / UNCORRECTABLE_REMAPPED_ROWS: ${h.text}`;
    },
    groupOf: (d) => deviceHealth(d).level,
  },
  {
    key: "pods",
    title: "Pods",
    width: 90,
    min: 50,
    num: true,
    value: (d) => d.pods.length,
    title_: (d) => d.pods.join("\n"),
  },
  {
    key: "podlist",
    link: (d) => (d.pods.length === 1 ? podRefLink(d.pods[0]) : undefined),
    title: "Pod names",
    width: 360,
    min: 100,
    value: (d) => d.pods.join(", "),
    className: "gpuext-dim",
  },
];

export const DevicesPage = observer(({ extension }: { extension: Renderer.LensExtension }) => {
  const devs = gpuStore.devices;
  const idle = devs.filter((d) => d.pods.length === 0 && d.utilPct < 5).length;
  // Only dcgm-exporter can report profiling counters; say so when it runs without them.
  const hasDcgm = gpuStore.snapshot?.exporters.some((e) => e.kind === "dcgm") ?? false;
  const sick = devs.filter((d) => ["bad", "warn"].includes(deviceHealth(d).level)).length;
  const hasXidOrEcc = devs.some((d) => d.lastXid !== undefined || d.eccDbe !== undefined);
  const hasProf = devs.some(
    (d) => d.smActivePct !== undefined || d.tensorActivePct !== undefined || d.dramActivePct !== undefined,
  );
  return (
    <PageShell
      extension={extension}
      title="GPUs"
      subtitle={
        devs.length > 0 && (
          <>
            {devs.length} device{devs.length === 1 ? "" : "s"} · {idle} with no pod and idle · total VRAM{" "}
            {fmtMiB(devs.reduce((s, d) => s + d.vramTotalMiB, 0))} · {totalPowerW(devs).toFixed(0)} W
            {sick > 0 && <span className="gpuext-hot"> · {sick} with health issues</span>}
            {hasDcgm && !hasXidOrEcc && (
              <div className="gpuext-hint">
                XID and ECC counters (<code>DCGM_FI_DEV_XID_ERRORS</code>, <code>ECC_DBE_VOL_TOTAL</code>) are not
                exported, so Health can only show row-remap state; add them to dcgm-exporter's counters CSV.
              </div>
            )}
            {hasDcgm && !hasProf && (
              <div className="gpuext-hint">
                GPU % is kernel time only: a card can read 100% while its SMs do little. The profiling counters that
                show real work (<code>DCGM_FI_PROF_SM_ACTIVE</code>, <code>PIPE_TENSOR_ACTIVE</code>,{" "}
                <code>DRAM_ACTIVE</code>) are not exported; enable them in dcgm-exporter's counters CSV to fill SM
                active / Tensor / Mem BW.
              </div>
            )}
          </>
        )
      }
    >
      <DataGrid
        id="devices"
        columns={DEVICE_COLUMNS}
        rows={devs}
        rowKey={(d) => `${d.node}/${d.gpu}`}
        defaultSort={{ key: "gpu", dir: "asc" }}
        groupOf={(d) => d.node}
        emptyText="No per-device metrics in this snapshot."
      />
    </PageShell>
  );
});
