import { Renderer as R } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import React from "react";
import { type Column, DataGrid } from "../components/data-grid";
import { nodeLink, podLink, serviceLink } from "../components/links";
import { PageShell } from "../components/page-shell";
import { gpuStore } from "../gpu/store";
import { formatTarget } from "../gpu/targets";

import type { Renderer } from "@freelensapp/extensions";

import type { ProbeResult } from "../gpu/scraper";
import type { ExporterScrape } from "../gpu/types";

const EXPORTER_COLUMNS: Column<ExporterScrape>[] = [
  { key: "ns", title: "Namespace", width: 150, min: 60, value: (e) => e.namespace, groupOf: (e) => e.namespace },
  {
    key: "name",
    link: (e) => (e.via === "prometheus" ? serviceLink(e.namespace, e.name) : podLink(e.namespace, e.name)),
    title: "Pod",
    width: 320,
    min: 80,
    value: (e) => e.name,
  },
  { key: "port", title: "Port", width: 70, min: 50, num: true, value: (e) => e.port },
  {
    key: "kind",
    title: "Kind",
    width: 170,
    min: 60,
    value: (e) => `${e.kind}${e.via ? ` ${e.via}` : ""}`,
    render: (e) => (
      <span className="gpuext-badge">
        {e.kind === "dcgm" ? "dcgm-exporter" : "per-process"}
        {e.via === "prometheus" ? " via Prometheus" : ""}
      </span>
    ),
  },
  {
    key: "node",
    link: (e) => (e.via === "prometheus" || e.nodeName.includes(",") ? undefined : nodeLink(e.nodeName)),
    title: "Node",
    width: 220,
    min: 80,
    value: (e) => e.nodeName,
    className: "gpuext-dim",
    groupOf: (e) => e.nodeName,
  },
  {
    key: "latency",
    title: "Scrape",
    width: 90,
    min: 60,
    num: true,
    value: (e) => e.latencyMs ?? -1,
    render: (e) => (e.latencyMs === undefined ? "–" : `${e.latencyMs} ms`),
  },
  {
    key: "bytes",
    title: "Body",
    width: 90,
    min: 60,
    num: true,
    value: (e) => e.bytes ?? -1,
    render: (e) => (e.bytes === undefined ? "–" : `${(e.bytes / 1024).toFixed(0)} KiB`),
  },
  { key: "error", title: "Error", width: 360, min: 80, value: (e) => e.error ?? "", className: "gpuext-error-text" },
];

const PROBE_COLUMNS: Column<ProbeResult>[] = [
  { key: "target", title: "Candidate (ns/pod:port)", width: 420, min: 100, value: (p) => p.target },
  { key: "outcome", title: "Outcome", width: 120, min: 60, value: (p) => p.outcome, groupOf: (p) => p.outcome },
  { key: "detail", title: "Detail", width: 600, min: 100, value: (p) => p.detail ?? "", className: "gpuext-dim" },
];

const { Button, Input } = R.Component;

/** Pinned targets: exporter pods or a Prometheus service that discovery would not find on its own. */
const PinEditor = observer(() => {
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string>();
  const add = () => {
    const err = gpuStore.addPin(value);
    setError(err);
    if (!err) setValue("");
  };
  return (
    <div className="gpuext-pins">
      <div className="gpuext-hint">
        Pin a target when discovery misses it — <code>namespace/pod-prefix:port</code> for exporter pods (matched by
        name prefix, so DaemonSet restarts keep working) or <code>namespace/svc/name:port</code> for a
        Prometheus-compatible query API (used when no exporter pod answers). Pins are kept per cluster on this machine.
      </div>
      <div className="gpuext-actions">
        <Input
          placeholder="gpu-mon/my-exporter:9400  or  monitoring/svc/vm-single:8428"
          value={value}
          onChange={(v: string) => {
            setValue(v);
            setError(undefined);
          }}
          onKeyDown={(e: React.KeyboardEvent) => {
            if (e.key === "Enter") add();
          }}
        />
        <Button primary label="Pin" disabled={!value.trim()} onClick={add} />
      </div>
      {error && <div className="gpuext-error">{error}</div>}
      {gpuStore.pins.length > 0 && (
        <div className="gpuext-pin-list">
          {gpuStore.pins.map((t) => (
            <span key={formatTarget(t)} className="gpuext-badge gpuext-mono">
              {formatTarget(t)}{" "}
              <button type="button" className="gpuext-link" title="Remove pin" onClick={() => gpuStore.removePin(t)}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
});

export const ExportersPage = observer(({ extension }: { extension: Renderer.LensExtension }) => {
  const snap = gpuStore.snapshot;
  const exporters = snap?.exporters ?? [];
  const probes = gpuStore.probes;
  return (
    <PageShell
      extension={extension}
      title="Exporters"
      subtitle={
        <>
          How GPU metrics reach this view. Discovery lists pods, keeps Running ones whose name/image/labels mention
          dcgm, gpu, nvidia or cuda, probes each <code>/metrics</code> through the apiserver pod-proxy and classifies by
          content. If no exporter pod answers, a Prometheus-compatible query API in the cluster is used instead.
          Discovery is cached for 60 s; Refresh re-runs it.
        </>
      }
    >
      <h3 className="gpuext-h3">Pinned targets ({gpuStore.pins.length})</h3>
      <PinEditor />
      <h3 className="gpuext-h3">Scraped exporters ({exporters.length})</h3>
      <DataGrid
        id="exporters"
        columns={EXPORTER_COLUMNS}
        rows={exporters}
        rowKey={(e) => `${e.namespace}/${e.name}`}
        defaultSort={{ key: "node", dir: "asc" }}
        emptyText="No exporter scraped."
      />
      <h3 className="gpuext-h3">Last discovery probes ({probes.length})</h3>
      <DataGrid
        id="probes"
        columns={PROBE_COLUMNS}
        rows={probes}
        rowKey={(p) => p.target}
        defaultSort={{ key: "target", dir: "asc" }}
        emptyText="No candidates were probed."
      />
    </PageShell>
  );
});
