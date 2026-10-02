import { describe, expect, it, vi } from "vitest";

// data-grid links cells to Freelens' details panel; the host API does not exist outside Freelens.
vi.mock("@freelensapp/extensions", () => ({ Renderer: { Navigation: { showDetails() {} } } }));

const { activeGrouper, gridTemplate } = await import("../data-grid");

import type { Column } from "../data-grid";

interface Row {
  ns: string;
  pod: string;
  gpu: string;
  pct: number;
}

const byNs = (r: Row) => r.ns;
const byCard = (r: Row) => r.gpu.split(":")[0];

const columns: Column<Row>[] = [
  { key: "ns", title: "Namespace", width: 100, value: (r) => r.ns, groupOf: byNs },
  { key: "pod", title: "Pod", width: 100, value: (r) => r.pod },
  { key: "gpu", title: "GPU", width: 100, value: (r) => r.gpu, groupOf: byCard },
  { key: "pct", title: "GPU %", width: 100, num: true, value: (r) => r.pct },
];
const defaultSort = { key: "gpu", dir: "asc" as const };

describe("activeGrouper", () => {
  it("uses the grid-level grouper when unsorted", () => {
    expect(activeGrouper(columns, undefined, defaultSort, byCard)).toBe(byCard);
  });

  it("keeps the grid-level grouper under the default sort key in either direction", () => {
    expect(activeGrouper(columns, { key: "gpu", dir: "desc" }, defaultSort, byCard)).toBe(byCard);
  });

  it("switches to the sorted column's own grouper", () => {
    expect(activeGrouper(columns, { key: "ns", dir: "asc" }, defaultSort, byCard)).toBe(byNs);
  });

  it("draws no separators when the sorted column has no grouping", () => {
    expect(activeGrouper(columns, { key: "pod", dir: "asc" }, defaultSort, byCard)).toBeUndefined();
    expect(activeGrouper(columns, { key: "pct", dir: "desc" }, defaultSort, byCard)).toBeUndefined();
  });

  it("falls back to the grid-level grouper only for the default key when the column has none", () => {
    const cols = columns.map((c) => (c.key === "gpu" ? { ...c, groupOf: undefined } : c));
    expect(activeGrouper(cols, { key: "gpu", dir: "asc" }, defaultSort, byCard)).toBe(byCard);
    expect(activeGrouper(cols, { key: "pod", dir: "asc" }, defaultSort, byCard)).toBeUndefined();
  });
});

describe("gridTemplate", () => {
  const cols: Column<Row>[] = [
    { key: "pod", title: "Pod", width: 360, min: 80, flex: 160, value: (r) => r.pod },
    { key: "gpu", title: "GPU", width: 90, value: (r) => r.gpu },
    { key: "pct", title: "GPU %", width: 230, min: 90, num: true, value: (r) => r.pct },
  ];

  it("lets flex columns share the free width down to their floor, and keeps the others fixed", () => {
    expect(gridTemplate(cols, [360, 90, 230])).toBe("minmax(160px, 360fr) 90px 230px");
  });

  it("fixes a flex column once it is resized by hand", () => {
    expect(gridTemplate(cols, [200, 90, 300])).toBe("200px 90px 300px");
  });

  it("falls back to the default width, and never floors above it", () => {
    const wide: Column<Row>[] = [{ key: "pod", title: "Pod", width: 120, flex: 200, value: (r) => r.pod }];
    expect(gridTemplate(wide, [])).toBe("minmax(120px, 120fr)");
  });
});
