import { observer } from "mobx-react";
import { type Column, DataGrid } from "../components/data-grid";
import { namespaceLink, podLink } from "../components/links";
import { PageShell } from "../components/page-shell";
import { gpuStore, type PendingRow } from "../gpu/store";

import type { Renderer } from "@freelensapp/extensions";

const fmtAge = (ms?: number) => {
  if (ms === undefined) return "–";
  const m = Math.max(0, (Date.now() - ms) / 60_000);
  if (m < 1) return "<1 min";
  if (m < 60) return `${m.toFixed(0)} min`;
  if (m < 48 * 60) return `${(m / 60).toFixed(1)} h`;
  return `${(m / 1440).toFixed(0)} d`;
};

const requestsText = (r: PendingRow) =>
  Object.entries(r.requests)
    .map(([k, v]) => `${k.replace(/^nvidia\.com\//, "")} ×${v}`)
    .join(", ");

const PENDING_COLUMNS: Column<PendingRow>[] = [
  {
    key: "namespace",
    link: (r) => namespaceLink(r.namespace),
    title: "Namespace",
    width: 140,
    min: 60,
    value: (r) => r.namespace,
    groupOf: (r) => r.namespace,
  },
  { key: "pod", link: (r) => podLink(r.namespace, r.pod), title: "Pod", width: 320, min: 80, value: (r) => r.pod },
  {
    key: "age",
    title: "Waiting",
    width: 90,
    min: 60,
    num: true,
    value: (r) => (r.createdAt === undefined ? -1 : Date.now() - r.createdAt),
    render: (r) => fmtAge(r.createdAt),
    title_: (r) => (r.createdAt ? new Date(r.createdAt).toLocaleString() : "creation time unknown"),
  },
  {
    key: "requests",
    title: "Requests",
    width: 190,
    min: 80,
    value: requestsText,
    render: (r) => (
      <>
        {Object.entries(r.requests).map(([k, v]) => (
          <span key={k} className="gpuext-badge gpuext-mono">
            {k.replace(/^nvidia\.com\//, "")} ×{v}
          </span>
        ))}
      </>
    ),
    groupOf: requestsText,
  },
  {
    key: "hint",
    title: "Why",
    width: 420,
    min: 100,
    value: (r) => r.hints.join(" "),
    render: (r) =>
      r.hints.length > 0 ? (
        <span className="gpuext-warn">{r.hints.join(" ")}</span>
      ) : (
        <span className="gpuext-dim">waiting for a free device</span>
      ),
  },
  {
    key: "message",
    title: "Scheduler says",
    width: 520,
    min: 100,
    value: (r) => r.message ?? r.reason ?? "",
    className: "gpuext-dim",
  },
];

export const PendingPage = observer(({ extension }: { extension: Renderer.LensExtension }) => {
  const rows = gpuStore.pendingRows;
  const blocked = rows.filter((r) => r.hints.length > 0).length;
  return (
    <PageShell
      extension={extension}
      title="Pods waiting for a GPU"
      podOnly
      subtitle={
        <>
          Pending pods the scheduler has not placed that request a GPU resource (<code>nvidia.com/gpu</code>,{" "}
          <code>nvidia.com/mig-*</code>). "Why" flags requests no node can ever satisfy; the scheduler message is shown
          as-is. Refreshed with discovery (every 60 s).
          {rows.length > 0 && (
            <>
              {" "}
              {rows.length} waiting{blocked > 0 ? `, ${blocked} can never be scheduled as written` : ""}.
            </>
          )}
        </>
      }
    >
      <DataGrid
        id="pending"
        columns={PENDING_COLUMNS}
        rows={rows}
        rowKey={(r) => `${r.namespace}/${r.pod}`}
        defaultSort={{ key: "age", dir: "desc" }}
        emptyText="No pods are waiting for a GPU."
      />
    </PageShell>
  );
});
