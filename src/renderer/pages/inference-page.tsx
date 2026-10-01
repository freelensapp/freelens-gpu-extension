import { observer } from "mobx-react";
import { type Column, DataGrid } from "../components/data-grid";
import { namespaceLink, podLink } from "../components/links";
import { PageShell } from "../components/page-shell";
import { fmtMiB } from "../components/styles";
import { UtilBar } from "../components/util-bar";
import { gpuStore, type InferenceRow } from "../gpu/store";

import type { Renderer } from "@freelensapp/extensions";

const num = (v: number | undefined, digits = 0) => (v === undefined ? "–" : v.toFixed(digits));

const statusClass = { bad: "gpuext-hot", warn: "gpuext-warn", ok: "gpuext-ok", idle: "gpuext-dim" } as const;

const hitRate = (r: InferenceRow) =>
  r.sample?.prefixHits !== undefined && r.sample.prefixQueries
    ? (100 * r.sample.prefixHits) / r.sample.prefixQueries
    : undefined;

const INFERENCE_COLUMNS: Column<InferenceRow>[] = [
  {
    key: "namespace",
    title: "Namespace",
    width: 120,
    min: 60,
    value: (r) => r.namespace,
    link: (r) => namespaceLink(r.namespace),
    groupOf: (r) => r.namespace,
  },
  { key: "pod", title: "Pod", width: 250, min: 80, value: (r) => r.pod, link: (r) => podLink(r.namespace, r.pod) },
  {
    key: "model",
    title: "Model",
    width: 180,
    min: 80,
    value: (r) => r.sample?.models.join(", ") ?? "",
    className: "gpuext-mono",
    title_: (r) => `${r.engine}${r.sample?.models.length ? `: ${r.sample.models.join(", ")}` : ""}`,
  },
  {
    key: "status",
    title: "Status",
    width: 260,
    min: 80,
    value: (r) => ({ bad: 0, warn: 1, ok: 2, idle: 3 })[r.status.level],
    render: (r) => <span className={statusClass[r.status.level]}>{r.status.text}</span>,
    title_: (r) => r.status.text,
    groupOf: (r) => r.status.level,
  },
  {
    key: "kv",
    title: "KV cache",
    width: 170,
    min: 90,
    value: (r) => r.sample?.kvCachePct ?? -1,
    render: (r) => (r.sample?.kvCachePct === undefined ? "–" : <UtilBar pct={r.sample.kvCachePct} />),
    title_: () => "vllm:kv_cache_usage_perc: KV cache blocks in use; near 100% the engine preempts or queues requests",
  },
  { key: "running", title: "Running", width: 80, min: 50, num: true, value: (r) => r.sample?.running ?? -1 },
  {
    key: "waiting",
    title: "Waiting",
    width: 80,
    min: 50,
    num: true,
    value: (r) => r.sample?.waiting ?? -1,
    render: (r) => (
      <span className={(r.sample?.waiting ?? 0) > 0 ? "gpuext-warn" : ""}>{r.sample?.waiting ?? "–"}</span>
    ),
  },
  {
    key: "gen",
    title: "Gen tok/s",
    width: 90,
    min: 60,
    num: true,
    value: (r) => r.rates.generationTokPerSec ?? -1,
    render: (r) => num(r.rates.generationTokPerSec),
    title_: (r) => `prompt ${num(r.rates.promptTokPerSec)} tok/s; rates are measured between two scrapes`,
  },
  {
    key: "ttft",
    title: "TTFT",
    width: 85,
    min: 60,
    num: true,
    value: (r) => r.rates.ttftMs ?? -1,
    render: (r) => (r.rates.ttftMs === undefined ? "–" : `${r.rates.ttftMs.toFixed(0)} ms`),
    title_: () => "mean time to first token of the requests that started since the previous scrape",
  },
  {
    key: "prefix",
    title: "Prefix hit",
    width: 90,
    min: 60,
    num: true,
    value: (r) => hitRate(r) ?? -1,
    render: (r) => (hitRate(r) === undefined ? "–" : `${hitRate(r)?.toFixed(0)}%`),
    title_: () => "prefix cache hits / queries since the engine started",
  },
  {
    key: "gpu",
    title: "GPU",
    width: 190,
    min: 80,
    value: (r) => r.gpu?.gpuUtilPct ?? -1,
    render: (r) =>
      r.gpu ? (
        <>
          <span className="gpuext-badge gpuext-mono">{r.gpu.gpus.join(",")}</span>
          <UtilBar pct={r.gpu.gpuUtilPct} />
        </>
      ) : (
        <span className="gpuext-dim">not attributed</span>
      ),
    title_: (r) =>
      r.gpu
        ? `GPU ${r.gpu.gpus.join(", ")}: ${r.gpu.gpuUtilPct.toFixed(1)}%, ${fmtMiB(r.gpu.vramUsedMiB)} VRAM${
            r.sample?.gpuMemoryUtilization
              ? ` (vLLM reserves ${(r.sample.gpuMemoryUtilization * 100).toFixed(0)}% by design)`
              : ""
          }`
        : "no GPU exporter attributes a device to this pod",
  },
];

export const InferencePage = observer(({ extension }: { extension: Renderer.LensExtension }) => {
  const rows = gpuStore.inferenceRows;
  const running = rows.reduce((s, r) => s + (r.sample?.running ?? 0), 0);
  const waiting = rows.reduce((s, r) => s + (r.sample?.waiting ?? 0), 0);
  const tok = rows.reduce((s, r) => s + (r.rates.generationTokPerSec ?? 0), 0);
  return (
    <PageShell
      extension={extension}
      title="Inference servers"
      podOnly
      subtitle={
        <>
          vLLM servers found among GPU pods (their own <code>/metrics</code>, through the pod proxy). GPU % alone is
          misleading for them: vLLM reserves most of the VRAM up front and can queue requests at modest SM use, so KV
          cache and the request queue are what show whether it keeps up.
          {rows.length > 0 && (
            <>
              {" "}
              {rows.length} server{rows.length === 1 ? "" : "s"} · {running} running · {waiting} waiting ·{" "}
              {tok.toFixed(0)} tok/s generated.
            </>
          )}
        </>
      }
    >
      <DataGrid
        id="inference"
        columns={INFERENCE_COLUMNS}
        rows={rows}
        rowKey={(r) => `${r.namespace}/${r.pod}`}
        defaultSort={{ key: "status", dir: "asc" }}
        emptyText="No vLLM server found among the Running pods that request a GPU."
      />
    </PageShell>
  );
});
