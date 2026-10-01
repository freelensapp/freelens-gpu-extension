import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import React from "react";
import { deviceHealth, nodeHealth, totalPowerW } from "../gpu/aggregate";
import { gpuStore } from "../gpu/store";
import { GpuTable } from "./gpu-table";
import { fmtMiB, gpuStyles } from "./styles";

const { DrawerTitle } = Renderer.Component;

type Props = Renderer.Component.KubeObjectDetailsProps<Renderer.K8sApi.Node>;

/** "GPU" section in the Node details drawer: every GPU row on that node. */
export const NodeGpuDetails = observer(({ object: node }: Props) => {
  React.useEffect(() => gpuStore.subscribe(), []);
  const rows = gpuStore.rowsForNode(node.getName());
  const devs = gpuStore.devicesForNode(node.getName());
  if (rows.length === 0 && devs.length === 0) return null;
  return (
    <div className="gpuext-details">
      <style>{gpuStyles}</style>
      <DrawerTitle>
        GPU {(() => {
          const withdrawn = gpuStore.allocation.find((a) => a.node === node.getName())?.unhealthy ?? 0;
          const h = nodeHealth(devs, withdrawn);
          const cls = { bad: "gpuext-hot", warn: "gpuext-warn", ok: "gpuext-ok", unknown: "gpuext-dim" }[h.level];
          return (
            <span className={`gpuext-badge ${cls}`} title={h.text}>
              {h.level === "unknown" ? "health not exported" : h.level === "ok" ? "healthy" : h.text}
            </span>
          );
        })()}
      </DrawerTitle>
      {devs.length > 0 && (
        <div className="gpuext-hint">
          {devs.length} device{devs.length === 1 ? "" : "s"}
          {devs[0].model ? ` · ${devs[0].model}` : ""} · {fmtMiB(devs.reduce((s, d) => s + d.vramUsedMiB, 0))} /{" "}
          {fmtMiB(devs.reduce((s, d) => s + d.vramTotalMiB, 0))} VRAM · {totalPowerW(devs).toFixed(0)} W
          {devs.some((d) => d.tempC !== undefined)
            ? ` · max ${Math.max(...devs.map((d) => d.tempC ?? 0)).toFixed(0)} °C`
            : ""}
          {devs.some((d) => ["bad", "warn"].includes(deviceHealth(d).level)) && (
            <span className="gpuext-hot">
              {" "}
              · health:{" "}
              {devs
                .filter((d) => ["bad", "warn"].includes(deviceHealth(d).level))
                .map((d) => `GPU ${d.gpu} ${deviceHealth(d).text}`)
                .join("; ")}
            </span>
          )}
        </div>
      )}
      {rows.length > 0 && <GpuTable rows={rows} hideNode />}
      {gpuStore.snapshot && (
        <div className="gpuext-hint">last scrape {gpuStore.snapshot.scrapedAt.toLocaleTimeString()}</div>
      )}
    </div>
  );
});
