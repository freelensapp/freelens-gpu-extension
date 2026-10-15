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
