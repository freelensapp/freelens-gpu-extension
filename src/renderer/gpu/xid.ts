/**
 * NVIDIA XID codes and clock-event (throttle) reasons, decoded for people.
 * Source: NVIDIA's XID catalogue and DCGM field docs. Application-caused XIDs
 * (a kernel faulting, a process killed mid-flight) are warnings: the GPU is
 * usually fine. Hardware / driver XIDs mean the device needs attention.
 */

export interface XidInfo {
  meaning: string;
  /** true: usually the workload's fault, the GPU is fine. */
  application: boolean;
}

const XIDS: Record<number, XidInfo> = {
  8: { meaning: "GPU stopped responding (timeout)", application: false },
  13: { meaning: "graphics engine exception (usually an application fault)", application: true },
  31: { meaning: "GPU memory page fault (usually an application fault)", application: true },
  32: { meaning: "invalid or corrupted push buffer stream", application: false },
  38: { meaning: "driver firmware error", application: false },
  43: { meaning: "GPU stopped processing (application error)", application: true },
  45: { meaning: "preemptive cleanup, process killed", application: true },
  48: { meaning: "double-bit ECC error", application: false },
  61: { meaning: "internal micro-controller breakpoint", application: false },
  62: { meaning: "internal micro-controller halt", application: false },
  63: { meaning: "ECC page retirement / row remap recorded", application: false },
  64: { meaning: "ECC page retirement / row remap failed", application: false },
  68: { meaning: "video decoder exception", application: false },
  69: { meaning: "graphics engine class error", application: false },
  74: { meaning: "NVLink error", application: false },
  79: { meaning: "GPU has fallen off the bus", application: false },
  92: { meaning: "high single-bit ECC error rate", application: false },
  94: { meaning: "contained ECC error", application: false },
  95: { meaning: "uncontained ECC error", application: false },
  109: { meaning: "context switch timeout", application: false },
  119: { meaning: "GSP RPC timeout", application: false },
  120: { meaning: "GSP error", application: false },
};

export function xidInfo(code: number): XidInfo {
  return XIDS[code] ?? { meaning: "see NVIDIA's XID catalogue", application: false };
}

/** DCGM_FI_DEV_CLOCK_THROTTLE_REASONS / CLOCKS_EVENT_REASONS bitmask. */
const REASONS: { bit: number; label: string; serious: boolean }[] = [
  { bit: 0x4, label: "software power cap", serious: false },
  { bit: 0x8, label: "hardware slowdown", serious: true },
  { bit: 0x20, label: "software thermal slowdown", serious: true },
  { bit: 0x40, label: "hardware thermal slowdown", serious: true },
  { bit: 0x80, label: "hardware power brake", serious: true },
];

/**
 * Active throttle reasons. Idle (0x1), application clock settings (0x2), sync boost (0x10) and display clocks (0x100)
 * are normal operation and left out.
 */
export function throttleReasons(mask: number): { label: string; serious: boolean }[] {
  const m = Math.trunc(mask);
  return REASONS.filter((r) => (m & r.bit) !== 0).map(({ label, serious }) => ({ label, serious }));
}
