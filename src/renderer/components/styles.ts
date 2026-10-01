/** Inline stylesheet, injected once per page. Uses Freelens theme variables. */
export const gpuStyles = `
.gpuext-page { display: flex; flex-direction: column; height: 100%; min-height: 0; box-sizing: border-box; padding: calc(var(--padding) * 2); color: var(--textColorPrimary); }
.gpuext-body { flex: 1 1 auto; min-height: 0; overflow: auto; }
.gpuext-header { display: flex; align-items: center; gap: var(--padding); margin-bottom: var(--padding); }
.gpuext-header h2 { margin: 0; font-weight: 500; flex: 1; }
.gpuext-version { display: inline-block; margin-left: 8px; padding: 1px 7px; border-radius: 10px; font-size: 11px; font-weight: 600; vertical-align: middle; background: var(--borderFaintColor); color: var(--textColorSecondary); font-family: var(--font-monospace, monospace); }
.gpuext-status { color: var(--textColorSecondary); font-size: 12px; }
.gpuext-error { color: var(--colorError); margin: var(--padding) 0; white-space: pre-wrap; }
.gpuext-hint { color: var(--textColorSecondary); font-size: 12px; margin: var(--padding) 0; }
.gpuext-grid { display: grid; width: max-content; min-width: 100%; font-size: 13px; align-items: stretch; }
.gpuext-row { display: contents; }
.gpuext-cell { padding: 6px 10px; border-bottom: 1px solid var(--borderFaintColor); white-space: nowrap; min-width: 0; line-height: 20px; box-sizing: border-box; }
.gpuext-head .gpuext-cell { position: sticky; top: 0; z-index: 1; background: var(--contentColor); font-weight: 500; color: var(--textColorSecondary); border-bottom: 1px solid var(--borderColor); }
.gpuext-th { position: relative; cursor: pointer; user-select: none; padding-right: 14px; }
.gpuext-th:hover { color: var(--textColorPrimary); }
.gpuext-th.sorted { color: var(--textColorPrimary); }
.gpuext-th-label { overflow: hidden; text-overflow: ellipsis; display: inline-block; max-width: 100%; }
.gpuext-sort { margin-left: 4px; font-size: 9px; vertical-align: middle; }
.gpuext-resize { position: absolute; top: 0; right: 0; width: 8px; height: 100%; cursor: col-resize; }
.gpuext-resize:hover, .gpuext-resize:active { background: var(--borderColor); }
.gpuext-sep .gpuext-cell { border-top: 2px solid var(--borderColor); }
.gpuext-cell.num { text-align: right; font-variant-numeric: tabular-nums; }
.gpuext-cell.ellipsis { overflow: hidden; text-overflow: ellipsis; }
.gpuext-mono { font-family: var(--font-monospace, monospace); }
.gpuext-dim { color: var(--textColorSecondary); }
.gpuext-bar { display: inline-block; width: 80px; height: 8px; border-radius: 4px; background: var(--borderFaintColor); vertical-align: middle; margin-right: 8px; overflow: hidden; }
.gpuext-bar > span { display: block; height: 100%; border-radius: 4px; }
.gpuext-bar.ok > span { background: var(--colorOk); }
.gpuext-bar.warn > span { background: var(--colorWarning); }
.gpuext-bar.hot > span { background: var(--colorError); }
.gpuext-bar.idle > span { background: var(--textColorTertiary); }
.gpuext-badge { display: inline-block; line-height: 18px; padding: 0 6px; border-radius: 4px; background: var(--borderFaintColor); margin-right: 4px; font-size: 12px; }
.gpuext-link { all: unset; cursor: pointer; color: var(--primary, var(--colorInfo)); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gpuext-link:hover { text-decoration: underline; }
.gpuext-pins { margin-bottom: var(--padding); }
.gpuext-pins .Input { min-width: 420px; }
.gpuext-pin-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: var(--padding); }
.gpuext-shared { margin-left: 6px; color: var(--colorWarning); }
.gpuext-details { font-size: 13px; }
.gpuext-subtitle { margin-top: 0; }
.gpuext-h3 { font-size: 13px; font-weight: 500; color: var(--textColorSecondary); margin: calc(var(--padding) * 2) 0 var(--padding); }
.gpuext-ok { color: var(--colorOk); }
.gpuext-warn { color: var(--colorWarning); }
.gpuext-hot { color: var(--colorError); font-weight: 600; }
.gpuext-error-text { color: var(--colorError); }
.gpuext-empty { color: var(--textColorSecondary); padding: calc(var(--padding) * 2); }
.gpuext-actions { display: flex; gap: var(--padding); align-items: center; }
`;

export function utilClass(pct: number): string {
  if (pct >= 90) return "hot";
  if (pct >= 70) return "warn";
  if (pct >= 30) return "ok";
  return "idle";
}

export function fmtMiB(v: number): string {
  if (v >= 1024) return `${(v / 1024).toFixed(1)} GiB`;
  return `${Math.round(v)} MiB`;
}
