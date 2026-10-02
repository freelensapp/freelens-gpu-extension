import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import React from "react";
import { scrapeStatus } from "../gpu/status";
import { gpuStore } from "../gpu/store";
import { GpuTable } from "./gpu-table";
import { gpuStyles } from "./styles";

const { DrawerTitle } = Renderer.Component;

type Props = Renderer.Component.KubeObjectDetailsProps<Renderer.K8sApi.Pod>;

/**
 * "GPU" section in the Pod details drawer. Only renders when the pod shows
 * up in the current snapshot (attributed row, or a fallback-mode candidate),
 * so pods without GPUs get no extra noise.
 */
export const PodGpuDetails = observer(({ object: pod }: Props) => {
  React.useEffect(() => gpuStore.subscribe(), []);
  const rows = gpuStore.rowsForPod(pod.getNs(), pod.getName());
  if (rows.length === 0) return null;
  const status = scrapeStatus(gpuStore.snapshot, gpuStore.error, false);
  return (
    <div className="gpuext-details">
      <style>{gpuStyles}</style>
      <DrawerTitle>GPU</DrawerTitle>
      {rows
        .filter((r) => r.health && r.health.level !== "ok")
        .map((r) => (
          <div
            key={r.gpus.join(",")}
            className={r.health?.level === "bad" ? "gpuext-error" : "gpuext-hint gpuext-warn"}
          >
            GPU {r.gpus.join(", ")}: {r.health?.text}
          </div>
        ))}
      <div className={status.stale ? "gpuext-stale" : undefined}>
        <GpuTable rows={rows} compact />
      </div>
      {gpuStore.snapshot && (
        <div className={`gpuext-hint${status.stale ? " gpuext-stale-note" : ""}`}>
          {status.stale ? status.text : `last scrape ${gpuStore.snapshot?.scrapedAt.toLocaleTimeString()}`}
        </div>
      )}
    </div>
  );
});
