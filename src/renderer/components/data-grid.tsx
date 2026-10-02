import React from "react";
import { openDetails } from "./links";

/**
 * Generic sortable / resizable grid rendered as CSS grid (the host app's
 * table CSS misaligns real <table>s). Column widths persist per `id` in
 * localStorage; headers sort on click; the handle at each header's right
 * edge resizes (double-click resets). Text columns marked `flex` share the
 * free width and shrink down to their `flex` floor (ellipsis), so the numbers stay in
 * sight in a narrow window; resizing one by hand fixes its width.
 */

export interface Column<T> {
  key: string;
  title: string;
  width: number;
  min?: number;
  /**
   * Free text (names, messages): while not resized by hand the column takes a share of the free width in proportion
   * to `width`, and shrinks down to this many px (kept readable, unlike `min`, the floor for resizing by hand) before
   * the grid scrolls horizontally.
   */
  flex?: number;
  /** Right-align (numbers). */
  num?: boolean;
  value: (row: T) => string | number;
  render?: (row: T) => React.ReactNode;
  /** Hover title for the cell; defaults to the string value. */
  title_?: (row: T) => string;
  /** Extra class for body cells. */
  className?: string;
  /**
   * Group id used for the heavier separator while THIS column is the sort key.
   * Omit for columns whose values are unique or continuous (pod names, percentages).
   */
  groupOf?: (row: T) => string;
  /** Kube selfLink for the object in this cell; the cell text becomes a link that opens its details panel. */
  link?: (row: T) => string | undefined;
}

export interface DataGridProps<T> {
  id: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  defaultSort?: { key: string; dir: "asc" | "desc" };
  /**
   * Group id under the default sort (and when unsorted); a heavier separator is drawn when it changes.
   * Sorting by another column switches to that column's own `groupOf`, if any.
   */
  groupOf?: (row: T) => string;
  emptyText?: string;
}

interface SortState {
  key: string;
  dir: "asc" | "desc";
}

function compare(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * Which grouping applies for the current sort: the sorted column's own grouper, else the grid-level
 * grouper when unsorted or sorted by the default column, else none (separators would be meaningless).
 */
export function activeGrouper<T>(
  columns: Column<T>[],
  sort: SortState | undefined,
  defaultSort: SortState | undefined,
  groupOf?: (row: T) => string,
): ((row: T) => string) | undefined {
  if (!sort) return groupOf;
  const col = columns.find((c) => c.key === sort.key);
  if (col?.groupOf) return col.groupOf;
  if (defaultSort && sort.key === defaultSort.key) return groupOf;
  return undefined;
}

// v2: widths are stored by position, and 0.8.1 reordered the columns of some views.
function storageKey(id: string) {
  return `freelens-gpu-extension.colwidths.v2.${id}`;
}

/** CSS grid tracks: a flex column keeps its proportional share until it is resized by hand (width != default). */
export function gridTemplate<T>(columns: Column<T>[], widths: number[]): string {
  return columns
    .map((c, i) => {
      const w = widths[i] ?? c.width;
      return c.flex !== undefined && w === c.width ? `minmax(${Math.min(c.flex, w)}px, ${w}fr)` : `${w}px`;
    })
    .join(" ");
}

function loadWidths<T>(id: string, cols: Column<T>[]): number[] {
  try {
    const raw = localStorage.getItem(storageKey(id));
    if (raw) {
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr) && arr.length === cols.length && arr.every((n) => typeof n === "number")) return arr;
    }
  } catch {
    /* ignore */
  }
  return cols.map((c) => c.width);
}

export function DataGrid<T>({ id, columns, rows, rowKey, defaultSort, groupOf, emptyText }: DataGridProps<T>) {
  const [sort, setSort] = React.useState<SortState | undefined>(defaultSort);
  const [widths, setWidths] = React.useState<number[]>(() => loadWidths(id, columns));
  const drag = React.useRef<{ idx: number; startX: number; startW: number } | null>(null);

  React.useEffect(() => {
    setWidths(loadWidths(id, columns));
  }, [id, columns]);

  const persist = (w: number[]) => {
    try {
      localStorage.setItem(storageKey(id), JSON.stringify(w));
    } catch {
      /* ignore */
    }
  };

  const onHandleDown = (idx: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // A flex column is rendered at its share of the free width, not at widths[idx]: start from what is on screen.
    const header = (e.currentTarget as HTMLElement).parentElement;
    const startW =
      columns[idx].flex !== undefined && header ? Math.round(header.getBoundingClientRect().width) : widths[idx];
    drag.current = { idx, startX: e.clientX, startW };
    const onMove = (ev: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      setWidths((w) => {
        const next = [...w];
        next[d.idx] = Math.max(columns[d.idx].min ?? 50, d.startW + (ev.clientX - d.startX));
        return next;
      });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      drag.current = null;
      setWidths((w) => {
        persist(w);
        return w;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const resetWidth = (idx: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setWidths((w) => {
      const next = [...w];
      next[idx] = columns[idx].width;
      persist(next);
      return next;
    });
  };

  const toggleSort = (key: string) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  const sorted = React.useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => sign * compare(col.value(a), col.value(b)));
  }, [rows, columns, sort]);

  const grouper = activeGrouper(columns, sort, defaultSort, groupOf);
  const template = gridTemplate(columns, widths);
  // With a flex column the grid fills the page (instead of max-content) so the fr tracks have a width to share.
  const fill = columns.some((c) => c.flex !== undefined);

  if (rows.length === 0 && emptyText) return <div className="gpuext-empty">{emptyText}</div>;

  let prevGroup = "";
  return (
    <div
      className="gpuext-grid"
      role="table"
      style={fill ? { gridTemplateColumns: template, width: "100%" } : { gridTemplateColumns: template }}
    >
      <div className="gpuext-row gpuext-head" role="row">
        {columns.map((c, i) => (
          <div
            key={c.key}
            className={`gpuext-cell gpuext-th${c.num ? " num" : ""}${sort?.key === c.key ? " sorted" : ""}`}
            role="columnheader"
            onClick={() => toggleSort(c.key)}
            title={`Sort by ${c.title}`}
          >
            <span className="gpuext-th-label">
              {c.title}
              {sort?.key === c.key && <span className="gpuext-sort">{sort.dir === "asc" ? "▲" : "▼"}</span>}
            </span>
            <span
              className="gpuext-resize"
              onMouseDown={onHandleDown(i)}
              onDoubleClick={resetWidth(i)}
              title="Drag to resize · double-click to reset"
            />
          </div>
        ))}
      </div>
      {sorted.map((r) => {
        const group = grouper ? grouper(r) : "";
        const sep = !!grouper && prevGroup !== "" && group !== prevGroup;
        prevGroup = group;
        return (
          <div key={rowKey(r)} className={`gpuext-row${sep ? " gpuext-sep" : ""}`} role="row">
            {columns.map((c) => {
              const v = c.value(r);
              const text = typeof v === "number" ? String(v) : v;
              return (
                <div
                  key={c.key}
                  className={`gpuext-cell ellipsis${c.num ? " num gpuext-mono" : ""}${c.className ? ` ${c.className}` : ""}`}
                  title={c.title_ ? c.title_(r) : text}
                >
                  {(() => {
                    const content = c.render ? c.render(r) : text;
                    const href = c.link?.(r);
                    return href ? (
                      <button
                        type="button"
                        className="gpuext-link"
                        onClick={(e) => {
                          e.stopPropagation();
                          openDetails(href);
                        }}
                      >
                        {content}
                      </button>
                    ) : (
                      content
                    );
                  })()}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
