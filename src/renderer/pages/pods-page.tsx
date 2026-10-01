import { observer } from "mobx-react";
import { GpuTable } from "../components/gpu-table";
import { PageShell } from "../components/page-shell";
import { gpuStore } from "../gpu/store";

import type { Renderer } from "@freelensapp/extensions";

export const PodsPage = observer(({ extension }: { extension: Renderer.LensExtension }) => {
  const snap = gpuStore.snapshot;
  const rows = gpuStore.rows;
  return (
    <PageShell extension={extension} title="GPU usage by pod">
      {rows.length === 0 && !gpuStore.error && (
        <div className="gpuext-empty">Exporters found, but no GPU metrics were returned.</div>
      )}
      {rows.length > 0 && <GpuTable rows={rows} />}
      {snap?.mode === "gpu" && (
        <div className="gpuext-hint">
          dcgm-exporter is not emitting pod labels, so rows are per (node, GPU). The arrow lists pods on that node
          requesting <code>nvidia.com/gpu</code>. Enable <code>--kubernetes</code> on dcgm-exporter for per-pod
          attribution.
        </div>
      )}
    </PageShell>
  );
});
