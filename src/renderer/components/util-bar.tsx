import { utilClass } from "./styles";

export function UtilBar({ pct }: { pct: number }) {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <>
      <span className={`gpuext-bar ${utilClass(pct)}`} title={`${pct.toFixed(1)}%`}>
        <span style={{ width: `${w}%` }} />
      </span>
      <span className="gpuext-mono">{pct.toFixed(1)}%</span>
    </>
  );
}
