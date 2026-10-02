import { observer } from "mobx-react";
import { type Column, DataGrid } from "../components/data-grid";
import { namespaceLink, nodeLink, podLink } from "../components/links";
import { PageShell } from "../components/page-shell";
import { fmtMiB } from "../components/styles";
import { gpuStore, IDLE_MIN_VRAM_MIB, IDLE_UTIL_PCT } from "../gpu/store";

import type { Renderer } from "@freelensapp/extensions";

import type { IdleRow } from "../gpu/types";

const fmtMin = (m: number) => (m < 1 ? "<1 min" : m < 60 ? `${m.toFixed(0)} min` : `${(m / 60).toFixed(1)} h`);

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
    title_: () => "highest utilisation seen for this pod in this session (up to 6 h)",
  },
  {
    key: "idle",
    title: "Idle for",
    width: 100,
    min: 60,
    num: true,
    value: (r) => r.idleMinutes,
    render: (r) => fmtMin(r.idleMinutes),
    title_: (r) => `${r.samples} sample${r.samples === 1 ? "" : "s"} since this view was opened`,
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

export const WastePage = observer(({ extension }: { extension: Renderer.LensExtension }) => {
  const rows = gpuStore.idleRows;
  const held = rows.reduce((s, r) => s + r.vramUsedMiB, 0);
  return (
    <PageShell
      extension={extension}
      title="Idle GPU holders"
      subtitle={
        <>
          Pods holding more than {fmtMiB(IDLE_MIN_VRAM_MIB)} of VRAM at under {IDLE_UTIL_PCT}% utilisation. "Idle for"
          counts consecutive idle samples observed by this Freelens window (history resets when Freelens restarts).
          {rows.length > 0 && (
            <>
              {" "}
              Currently {rows.length} pod{rows.length === 1 ? "" : "s"} holding {fmtMiB(held)}.
            </>
          )}
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
