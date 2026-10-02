/**
 * The scrape status shown in every page header and drawer. When the latest scrape failed, the rows of the last good
 * one stay on screen (useful during an incident), so the status must say they are old instead of counting exporters.
 */

import type { Snapshot } from "./types";

export interface ScrapeStatus {
  text: string;
  /** The rows on screen come from an older scrape than the one that just failed. */
  stale: boolean;
}

export function scrapeStatus(snap: Snapshot | undefined, error: string | undefined, loading: boolean): ScrapeStatus {
  if (snap && error) {
    return {
      text: `stale: last good scrape ${snap.scrapedAt.toLocaleTimeString()}, the latest one failed`,
      stale: true,
    };
  }
  if (snap) {
    const n = snap.exporters.length;
    const kinds = [...new Set(snap.exporters.map((e) => e.kind))].join(", ");
    return {
      text: `${n} exporter${n === 1 ? "" : "s"} (${kinds}) · last scrape ${snap.scrapedAt.toLocaleTimeString()}`,
      stale: false,
    };
  }
  return { text: loading ? "discovering exporters…" : "", stale: false };
}
