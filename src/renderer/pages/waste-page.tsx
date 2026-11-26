import { observer } from "mobx-react";
import React from "react";
import { type Column, DataGrid } from "../components/data-grid";
import { namespaceLink, nodeLink, podLink } from "../components/links";
import { PageShell } from "../components/page-shell";
import { fmtMiB } from "../components/styles";
import { LOOKBACK_WINDOWS, type LookbackWindow } from "../gpu/lookback";
import { gpuStore, IDLE_MIN_VRAM_MIB, IDLE_UTIL_PCT } from "../gpu/store";

import type { Renderer } from "@freelensapp/extensions";

import type { IdleRow } from "../gpu/types";

const fmtMin = (m: number) =>
  m < 1
    ? "<1 min"
    : m < 60
      ? `${m.toFixed(0)} min`
      : m < 48 * 60
        ? `${(m / 60).toFixed(1)} h`
        : `${(m / 1440).toFixed(1)} d`;
const windowLabel = () => LOOKBACK_WINDOWS[gpuStore.lookbackWindow].label;

const IDLE_COLUMNS: Column<IdleRow>[] = [
  {
    key: "namespace",
    link: (r) => namespaceLink(r.namespace),
    title: "Namespace",
    width: 130,
    flex: 100,
    min: 60,
    value: (r) => r.namespace,
    groupOf: (r) => r.namespace,
  },
  {
    key: "pod",
    link: (r) => podLink(r.namespace, r.pod),
    title: "Pod",
    width: 360,
    flex: 160,
    min: 80,
    value: (r) => r.pod,
    render: (r) => {
      const inf = gpuStore.inferenceRows.find((i) => i.namespace === r.namespace && i.pod === r.pod);
      return (
        <>
          {r.pod}
          {inf && (
            <span
              className="gpuext-badge gpuext-shared"
              title={`vLLM server: it reserves ${
                inf.sample?.gpuMemoryUtilization ? `${(inf.sample.gpuMemoryUtilization * 100).toFixed(0)}%` : "most"
              } of the VRAM by design, so idle VRAM is expected; see Inference for its queue and KV cache`}
            >
              vLLM
            </span>
          )}
        </>
      );
    },
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
  { key: "gpu", title: "GPU", width: 80, min: 50, value: (r) => r.gpus.join(","), className: "gpuext-mono" },
  {
    key: "vram",
    title: "VRAM held",
    width: 115,
    min: 60,
    num: true,
    value: (r) => r.vramUsedMiB,
    render: (r) => fmtMiB(r.vramUsedMiB),
  },
  {
    key: "util",
    title: "GPU % now",
    width: 90,
    min: 60,
    num: true,
    value: (r) => r.gpuUtilPct,
    render: (r) => `${r.gpuUtilPct.toFixed(1)}%`,
  },
  {
    key: "peak",
    title: "Peak in window",
    width: 135,
    min: 60,
    num: true,
    value: (r) => r.peakUtilPct,
    render: (r) => `${r.peakUtilPct.toFixed(1)}%`,
    title_: (r) =>
      r.lookback
        ? `highest utilisation of this pod in the last ${windowLabel()} (query API) and in this session`
        : "highest utilisation seen for this pod in this session (up to 6 h)",
  },
  {
    key: "idle",
    title: "Idle for",
    width: 100,
    min: 60,
    num: true,
    value: (r) => r.idleMinutes,
    render: (r) => `${r.idleAtLeast ? "≥ " : ""}${fmtMin(r.idleMinutes)}`,
    title_: (r) =>
      `${r.idleAtLeast ? "never seen busy, so at least this long; " : ""}${r.samples} sample${r.samples === 1 ? "" : "s"} in this session${
        r.lookback ? `, history from the query API (last ${windowLabel()})` : ""
      }`,
  },
  {
    key: "idleShare",
    title: "Idle share",
    width: 100,
    min: 60,
    num: true,
    value: (r) => r.lookback?.idleShare ?? -1,
    render: (r) => (r.lookback?.idleShare === undefined ? "–" : `${(r.lookback.idleShare * 100).toFixed(0)}%`),
    title_: (r) =>
      r.lookback?.idleShare === undefined
        ? "no history for this pod in the query API"
        : `share of the last ${windowLabel()} under ${IDLE_UTIL_PCT}% utilisation, over the ${fmtMin(r.lookback.observedMs / 60_000)} the pod has samples for`,
  },
  {
    key: "peakVram",
    title: "Peak VRAM",
    width: 110,
    min: 60,
    num: true,
    value: (r) => r.lookback?.peakVramMiB ?? -1,
    render: (r) => (r.lookback ? fmtMiB(r.lookback.peakVramMiB) : "–"),
    title_: (r) =>
      r.lookback
        ? `most VRAM this pod held in the last ${windowLabel()}; it holds ${fmtMiB(r.vramUsedMiB)} of ${fmtMiB(r.vramUsedMiB + r.vramFreeMiB)} now`
        : "no history for this pod in the query API",
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
];

/** Where the history comes from, with the switch between the windows. */
const LookbackNote = observer(() => {
  const lb = gpuStore.lookback;
  const current = gpuStore.lookbackWindow;
  const ready = lb?.window === current;
  return (
    <>
      {" "}
      {!ready || !lb
        ? "Reading the history from the query API of the cluster…"
        : lb.error
          ? `History could not be read (${lb.error}), so "Idle for" counts from when this Freelens window opened.`
          : lb.source
            ? `History of the last ${windowLabel()} from ${lb.source}: "Idle for" reaches back to the last busy moment, and Idle share and Peak VRAM cover that window.`
            : 'No Prometheus-compatible query API with GPU series was found, so "Idle for" counts from when this Freelens window opened (set yours in the cluster settings of Freelens, under Metrics, or pin it on the Exporters page).'}{" "}
      {(Object.keys(LOOKBACK_WINDOWS) as LookbackWindow[]).map((w) => (
        <button
          key={w}
          type="button"
          className="gpuext-link gpuext-window"
          disabled={w === current}
          title={`Read the last ${LOOKBACK_WINDOWS[w].label}`}
          onClick={() => gpuStore.setLookbackWindow(w)}
        >
          {LOOKBACK_WINDOWS[w].label}
        </button>
      ))}
    </>
  );
});

export const WastePage = observer(({ extension }: { extension: Renderer.LensExtension }) => {
  React.useEffect(() => gpuStore.subscribeLookback(), []);
  const rows = gpuStore.idleRows;
  const held = rows.reduce((s, r) => s + r.vramUsedMiB, 0);
  const unmeasured = gpuStore.rows.filter(
    (r) => r.utilUnpublished && !r.gpuIndex && r.vramUsedMiB >= IDLE_MIN_VRAM_MIB,
  ).length;
  return (
    <PageShell
      extension={extension}
      title="Idle GPU holders"
      subtitle={
        <>
          Pods holding more than {fmtMiB(IDLE_MIN_VRAM_MIB)} of VRAM at under {IDLE_UTIL_PCT}% utilisation.
          {rows.length > 0 && (
            <>
              {" "}
              Currently {rows.length} pod{rows.length === 1 ? "" : "s"} holding {fmtMiB(held)}.
            </>
          )}
          {unmeasured > 0 && (
            <>
              {" "}
              {unmeasured} pod{unmeasured === 1 ? "" : "s"} on AMD partitions {unmeasured === 1 ? "is" : "are"} left
              out: the exporter publishes no utilisation for them, so they cannot be called idle.
            </>
          )}
          <LookbackNote />
        </>
      }
    >
      <DataGrid
        id="idle"
        columns={IDLE_COLUMNS}
        rows={rows}
        rowKey={(r) => `${r.namespace}/${r.pod}`}
        defaultSort={{ key: "vram", dir: "desc" }}
        emptyText="No idle GPU holders right now."
      />
    </PageShell>
  );
});
