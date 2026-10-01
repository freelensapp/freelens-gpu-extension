/**
 * Minimal Prometheus text-exposition parser. Handles exactly what GPU
 * exporters emit: `name{label="value",...} value [timestamp]`, comments,
 * blank lines, escaped quotes/backslashes/newlines inside label values.
 * Histograms/summaries are parsed as plain samples (we never use them).
 */

export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export type Families = Map<string, Sample[]>;

export function parsePrometheusText(text: string): Families {
  const out: Families = new Map();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const s = parseLine(line);
    if (!s) continue;
    const arr = out.get(s.name);
    if (arr) arr.push(s);
    else out.set(s.name, [s]);
  }
  return out;
}

function parseLine(line: string): Sample | undefined {
  let i = 0;
  while (i < line.length && /[A-Za-z0-9_:]/.test(line[i])) i++;
  const name = line.slice(0, i);
  if (!name) return undefined;
  const labels: Record<string, string> = {};
  if (line[i] === "{") {
    i++;
    while (i < line.length && line[i] !== "}") {
      while (i < line.length && (line[i] === " " || line[i] === ",")) i++;
      if (line[i] === "}") break;
      const kStart = i;
      while (i < line.length && /[A-Za-z0-9_]/.test(line[i])) i++;
      const key = line.slice(kStart, i);
      if (line[i] !== "=") return undefined;
      i++;
      if (line[i] !== '"') return undefined;
      i++;
      let val = "";
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\") {
          const n = line[i + 1];
          val += n === "n" ? "\n" : n;
          i += 2;
        } else {
          val += line[i++];
        }
      }
      i++; // closing quote
      labels[key] = val;
    }
    i++; // closing brace
  }
  const rest = line.slice(i).trim().split(/\s+/);
  const value = parseFloatProm(rest[0]);
  if (value === undefined) return undefined;
  return { name, labels, value };
}

function parseFloatProm(s: string | undefined): number | undefined {
  if (s === undefined || s === "") return undefined;
  switch (s) {
    case "+Inf":
      return Number.POSITIVE_INFINITY;
    case "-Inf":
      return Number.NEGATIVE_INFINITY;
    case "NaN":
      return Number.NaN;
  }
  const v = Number(s);
  return Number.isNaN(v) ? undefined : v;
}

/** Classify an exporter by the metric families its /metrics body emits. */
export function classifyMetrics(text: string): "dcgm" | "enricher" | undefined {
  if (text.includes("gpu_process_memory_bytes")) return "enricher";
  if (text.includes("DCGM_FI_DEV_") || text.includes("DCGM_FI_PROF_")) return "dcgm";
  return undefined;
}
