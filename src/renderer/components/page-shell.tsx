import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import React from "react";
import { reportJson, reportMarkdown } from "../gpu/report";
import { gpuStore } from "../gpu/store";
import { gpuStyles } from "./styles";

const { Button, Spinner } = Renderer.Component;

export interface PageShellProps {
  extension: Renderer.LensExtension;
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  /** The page only needs the pod list (Pending, Namespaces): render it even when no exporter snapshot exists. */
  podOnly?: boolean;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Electron can deny the async clipboard API in some frames; fall back to a hidden textarea.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/** "Copy JSON" / "Copy Markdown": the whole cluster's GPU state, for Slack / Jira during an incident. */
const CopySnapshot = observer(({ extension }: { extension: Renderer.LensExtension }) => {
  const [done, setDone] = React.useState<string>();
  const copy = async (fmt: "json" | "md") => {
    const input = gpuStore.reportInput({
      cluster: Renderer.Catalog.getActiveCluster()?.name,
      extensionVersion: extension.version,
    });
    const ok = await copyText(fmt === "json" ? reportJson(input) : reportMarkdown(input));
    setDone(ok ? `${fmt === "json" ? "JSON" : "Markdown"} copied` : "copy failed");
    setTimeout(() => setDone(undefined), 2000);
  };
  return (
    <>
      {done && <span className="gpuext-status">{done}</span>}
      <Button plain label="Copy JSON" onClick={() => void copy("json")} />
      <Button plain label="Copy Markdown" onClick={() => void copy("md")} />
    </>
  );
});

/** Common chrome for every GPU page: title + version badge, scrape status, refresh, scrolling body. */
export const PageShell = observer(({ extension, title, subtitle, children, podOnly }: PageShellProps) => {
  React.useEffect(() => gpuStore.subscribe(), []);
  const snap = gpuStore.snapshot;
  const ready = !!snap || (!!podOnly && !!gpuStore.podState);
  const kinds = snap ? [...new Set(snap.exporters.map((e) => e.kind))].join(", ") : "";
  return (
    <div className="gpuext-page">
      <style>{gpuStyles}</style>
      <div className="gpuext-header">
        <h2>
          {title} <span className="gpuext-version">v{extension.version}</span>
        </h2>
        <span className="gpuext-status">
          {snap
            ? `${snap.exporters.length} exporter${snap.exporters.length === 1 ? "" : "s"} (${kinds}) · last scrape ${snap.scrapedAt.toLocaleTimeString()}`
            : gpuStore.loading
              ? "discovering exporters…"
              : ""}
        </span>
        <div className="gpuext-actions">
          {gpuStore.loading && <Spinner />}
          {ready && <CopySnapshot extension={extension} />}
          <Button plain label="Refresh" disabled={gpuStore.loading} onClick={() => void gpuStore.refresh(true)} />
        </div>
      </div>
      {subtitle && <div className="gpuext-hint gpuext-subtitle">{subtitle}</div>}
      {gpuStore.error && <div className="gpuext-error">{gpuStore.error}</div>}
      <div className="gpuext-body">
        {!ready && !gpuStore.loading && !gpuStore.error && (
          <div className="gpuext-empty">Waiting for the first scrape…</div>
        )}
        {ready && children}
      </div>
    </div>
  );
});
