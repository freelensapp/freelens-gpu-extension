import { observer } from "mobx-react";
import { type Column, DataGrid } from "../components/data-grid";
import { namespaceLink } from "../components/links";
import { PageShell } from "../components/page-shell";
import { fmtMiB } from "../components/styles";
import { UtilBar } from "../components/util-bar";
import { gpuStore, IDLE_MIN_VRAM_MIB, IDLE_UTIL_PCT } from "../gpu/store";

import type { Renderer } from "@freelensapp/extensions";

import type { NamespaceRow } from "../gpu/namespaces";

const resourcesText = (r: NamespaceRow) =>
  Object.entries(r.byResource)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k.replace(/^nvidia\.com\//, "")} ×${v}`)
    .join(", ");

const NS_COLUMNS: Column<NamespaceRow>[] = [
  {
    key: "namespace",
    link: (r) => namespaceLink(r.namespace),
    title: "Namespace",
    width: 200,
    min: 80,
    value: (r) => r.namespace,
  },
  {
    key: "requested",
    title: "Requested",
    width: 95,
    min: 60,
    num: true,
    value: (r) => r.requested,
    title_: (r) => resourcesText(r) || "no running pod requests a GPU",
  },
  {
    key: "resources",
    title: "Resources",
    width: 220,
    min: 80,
    value: resourcesText,
    className: "gpuext-dim gpuext-mono",
  },
  { key: "pods", title: "GPU pods", width: 85, min: 50, num: true, value: (r) => r.gpuPods },
  {
    key: "inUse",
    title: "In use",
    width: 75,
    min: 50,
    num: true,
    value: (r) => r.devicesInUse,
    title_: () => "devices the exporters attribute to this namespace's pods",
  },
  {
    key: "util",
    title: "Avg GPU %",
    width: 175,
    min: 90,
    value: (r) => r.avgUtilPct,
    title_: (r) => `${r.avgUtilPct.toFixed(1)}% mean over the namespace's attributed pods`,
    render: (r) => (r.devicesInUse > 0 ? <UtilBar pct={r.avgUtilPct} /> : <span className="gpuext-dim">–</span>),
  },
  {
    key: "vram",
    title: "VRAM held",
    width: 100,
    min: 60,
    num: true,
    value: (r) => r.vramUsedMiB,
    render: (r) => fmtMiB(r.vramUsedMiB),
  },
  {
    key: "idle",
    title: "Idle VRAM",
    width: 110,
    min: 60,
    num: true,
    value: (r) => r.idleVramMiB,
    render: (r) =>
      r.idlePods > 0 ? (
        <span className="gpuext-warn">
          {fmtMiB(r.idleVramMiB)} ({r.idlePods})
        </span>
      ) : (
        <span className="gpuext-dim">–</span>
      ),
    title_: (r) =>
      `${r.idlePods} pod(s) holding more than ${fmtMiB(IDLE_MIN_VRAM_MIB)} at under ${IDLE_UTIL_PCT}% (see Idle & waste)`,
  },
  {
    key: "pending",
    title: "Waiting",
    width: 80,
    min: 50,
    num: true,
    value: (r) => r.pending,
    render: (r) => <span className={r.pending > 0 ? "gpuext-warn" : "gpuext-dim"}>{r.pending}</span>,
    title_: () => "pods waiting for a GPU (see Pending)",
  },
  {
    key: "power",
    title: "Power",
    width: 90,
    min: 50,
    num: true,
    value: (r) => r.powerWatts,
    render: (r) => `${r.shared ? "≤ " : ""}${r.powerWatts.toFixed(0)} W`,
    title_: (r) =>
      r.shared
        ? "some pods share a device and carry its full power, so this sum over-counts"
        : "sum of the namespace's pods' power",
  },
];

export const NamespacesPage = observer(({ extension }: { extension: Renderer.LensExtension }) => {
  const rows = gpuStore.namespaceRows;
  const req = rows.reduce((s, r) => s + r.requested, 0);
  const idleVram = rows.reduce((s, r) => s + r.idleVramMiB, 0);
  return (
    <PageShell
      extension={extension}
      title="GPU usage by namespace"
      podOnly
      subtitle={
        <>
          Whose GPUs are these, and are they using them: devices requested by running pods, what the exporters measure
          for them, VRAM held by idle pods, and pods still waiting.
          {rows.length > 0 && (
            <>
              {" "}
              {rows.length} namespace{rows.length === 1 ? "" : "s"} · {req} devices requested
              {idleVram > 0 && <> · {fmtMiB(idleVram)} held idle</>}.
            </>
          )}
        </>
      }
    >
      <DataGrid
        id="namespaces"
        columns={NS_COLUMNS}
        rows={rows}
        rowKey={(r) => r.namespace}
        defaultSort={{ key: "requested", dir: "desc" }}
        emptyText="No namespace requests or uses a GPU."
      />
    </PageShell>
  );
});
