# Freelens GPU Extension

[![npm](https://img.shields.io/npm/v/%40freelensapp%2Fgpu-extension)](https://www.npmjs.com/package/@freelensapp/gpu-extension)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Per-pod **GPU usage inside [Freelens](https://freelens.app)**: utilisation, VRAM and power for every pod that holds a GPU, plus a GPU section in the Pod and Node detail drawers.

Zero cluster footprint. The extension auto-discovers a GPU metrics exporter you already run (NVIDIA **dcgm-exporter** from the GPU Operator, or any **per-process exporter** emitting `gpu_process_memory_bytes`) and scrapes it through the kube-apiserver **pod-proxy subresource**, using the same cluster connection Freelens already has. No DaemonSet, no port-forward, no Prometheus required.

It is the GUI counterpart of [`kubectl-gpugo`](https://github.com/Tal-Naeh/kubectl-gpugo) (`kubectl krew install gpugo`) and shares its attribution rules and data model, so both tools show the same numbers.

![Namespaces view: devices requested and in use per namespace, VRAM held idle, pods waiting and each namespace's share of the power](docs/screenshots/namespaces.png)

![GPUs view: 48 MIG slices on 8× A100, with profile, utilisation, SM / tensor / memory activity, VRAM and the node's real 804 W](docs/screenshots/gpus.png)

![Allocation view: node health, capacity vs requests, and free MIG slices per profile](docs/screenshots/allocation.png)

![Inference view: a vLLM server next to its GPU, with KV cache, queue, tokens/s and time to first token](docs/screenshots/inference.png)

Screenshots from an 8× A100 DGX with MIG; node and internal namespace names are blacked out.

## Features

- **Autodiscovery** — lists pods, keeps Running ones whose name, image or labels mention `dcgm`, `gpu`, `nvidia` or
  `cuda`, probes each `/metrics` and classifies by content: NVIDIA **dcgm-exporter** (`DCGM_FI_DEV_*`) or a
  **per-process exporter** (`gpu_process_memory_bytes`). Nothing to configure, nothing to deploy. If discovery misses
  yours, **pin** it per cluster on the Exporters page (`namespace/pod-prefix:port`).
- **Prometheus fallback** — when no exporter pod answers, reads the same metrics from a Prometheus / Thanos /
  VictoriaMetrics / Mimir query API already in the cluster (found automatically, or pinned as
  `namespace/svc/name:port`) through the service proxy, repairing the labels Prometheus rewrites.
- **Zero cluster footprint** — reads `/metrics` through the kube-apiserver pod-proxy subresource over Freelens' own
  cluster connection. No DaemonSet, no Prometheus required, no port-forward, no RBAC beyond `list pods`, `list nodes`,
  `get pods/proxy` (plus `list services` and `get services/proxy` for the Prometheus fallback).
- **Correct attribution** — per pod when the exporter carries pod labels; per MIG slice on partitioned cards (rows
  grouped under their physical GPU); per process when workloads bypass the device plugin with
  `NVIDIA_VISIBLE_DEVICES=all`; graceful per-(node, GPU) fallback with candidate pods otherwise. Same rules as
  [`kubectl-gpugo`](https://github.com/Tal-Naeh/kubectl-gpugo), so CLI and GUI agree.
- **Eight views** under a **GPU** sidebar group (below), plus GPU sections in the Pod and Node detail drawers.
- **Tables that behave** — click a header to sort, drag its right edge to resize (double-click resets, widths are
  remembered), sticky header while scrolling, full text on hover; pod, node and namespace names open Freelens' own
  details panel.
- **Copy snapshot** — every page has *Copy JSON* / *Copy Markdown*: the whole cluster's GPU state (health issues and
  waiting pods first) ready to paste into Slack or Jira during an incident.
- **Honest numbers** — device gauges are never double-counted; MIG power is counted once per card; pods on a shared or
  time-sliced GPU are badged because dcgm-exporter reports device-level numbers for them; the profiling counters (SM /
  tensor / memory activity) sit next to "GPU %", which is only kernel time; health shows "not exported" rather than a
  reassuring OK without data; and the version badge in every title tells you which build you are looking at.

## Views

All eight are fed by the same 20 s scrape (Pending, Namespaces and Inference work without a GPU exporter):

| View | Question it answers |
| --- | --- |
| **Pods** | Which pods hold GPUs right now, on which card / MIG slice, at what utilisation, VRAM and power. Sorted by physical GPU so pile-ups are obvious; `shared ×N` / `time-sliced` badges mark device-level numbers. |
| **Namespaces** | Whose GPUs are these, and are they using them: per namespace, devices requested (by resource), devices in use, mean utilisation, VRAM held, VRAM held idle, pods waiting, power. |
| **Inference** | vLLM servers next to their GPUs: model, **KV cache**, running / waiting requests, generated tokens/s, recent time to first token, prefix-cache hit rate, preemptions and errors, with a status (*saturated* when the KV cache is full and requests queue). Found automatically among GPU pods. |
| **GPUs** | One row per physical GPU or MIG slice: model, MIG profile, utilisation, **SM active / Tensor / Mem BW** (DCGM profiling counters), VRAM used / total / %, power, temperature, **Health** (XID with its meaning, uncorrectable ECC, row remapping, hardware throttling), and the pods sharing it. Cards with no pod are listed too. |
| **Idle & waste** | Pods holding VRAM at under 5 % utilisation, with how long they have been idle (history kept while Freelens is open). The first place to look before buying more GPUs. |
| **Allocation** | Per node: **health** (worst device, red when the device plugin withdrew GPUs), GPU capacity (`nvidia.com/gpu` + `nvidia.com/mig-*`), allocatable, **unhealthy** (capacity − allocatable), what pods request, **free MIG slices per profile**, and what the exporters measure as busy. Scheduler view and reality side by side. |
| **Pending** | Pods waiting for a GPU: how long, what they request, the scheduler's message, and a **Why** for requests that can never fit (a resource no node offers, `nvidia.com/gpu` on a MIG-partitioned cluster, more devices than any node has). |
| **Exporters** | What discovery found: each exporter's kind (or "via Prometheus"), node, scrape latency and body size, every candidate probed and why it was or wasn't accepted, and the **pinned targets** for this cluster. |

Every table sorts on header click, resizes by dragging the header edge (double-click resets, widths are remembered), keeps its header visible while scrolling, and shows the full text of a truncated cell on hover.

Also:
- **Pod details drawer**: a GPU section for pods that hold a GPU (silent for the rest), including a warning when the
  pod's GPU is unhealthy.
- **Node details drawer**: health badge, device summary (count, model, VRAM, power, max temperature) plus every GPU row
  on that node.
- The page title carries the extension version so you always know what you are looking at.

| Column | Meaning |
| --- | --- |
| GPU | GPU index(es): `2` (single), `0`,`1` (two cards), `0:8` (MIG slice 8 of GPU 0) |
| GPU % | Activity across the pod's GPUs (DCGM `GPU_UTIL`, or `PROF_GR_ENGINE_ACTIVE` on MIG) |
| VRAM used | Framebuffer used, summed across the pod's GPUs / slices |
| VRAM total | Used + free framebuffer for those GPUs / slices |
| Power | Watts; on shared GPUs, a proportional share by VRAM |

## Requirements

- An exporter the extension recognises, running in the cluster:
  - **dcgm-exporter**: image contains `dcgm-exporter`, or `/metrics` emits `DCGM_FI_DEV_*`. Per-pod attribution needs `--kubernetes` (the GPU Operator default); without it you get per-(node, GPU) rows with the candidate pods listed.
  - **Per-process exporter**: anything whose `/metrics` emits `gpu_process_memory_bytes` with `namespace`/`pod` labels. Preferred when present, because it attributes workloads that bypass the device plugin via `NVIDIA_VISIBLE_DEVICES=all`.
- RBAC for the kubeconfig user: `list pods` cluster-wide (discovery) and `get pods/proxy` in the exporter's namespace (the scrape).

## Installation

Open the Freelens **Extensions** page (`ctrl`+`shift`+`E` / `cmd`+`shift`+`E`), paste the npm name and click **Install**:

```text
@freelensapp/gpu-extension
```

Alternatively download the `.tgz` from the
[GitHub releases](https://github.com/freelensapp/freelens-gpu-extension/releases) page and drag it into the Freelens
window, or paste its absolute path on the Extensions page. After an upgrade, fully restart Freelens; the page title
shows the loaded version.

Requires Freelens ≥ 1.8 (developed and verified against 1.10.3).

## Usage

1. Connect to a cluster in Freelens. A **GPU** group appears in the sidebar.
2. **Pods** shows every GPU-holding pod; click a header to sort, drag to resize.
3. **GPUs** shows each card / MIG slice with the pods sharing it. **Idle & waste** lists pods holding VRAM at ~0 %
   utilisation and how long they have been idle. **Allocation** compares `nvidia.com/gpu` capacity, pod requests and
   measured busy devices per node.
4. Open any Pod or Node: a **GPU** section appears in its details drawer when the object holds a GPU.
5. Nothing found? **Exporters** lists every candidate pod that was probed and why it was or wasn't accepted.
   **Refresh** re-runs discovery.

## Development

```sh
pnpm install
pnpm type:check      # tsc
pnpm lint:check      # biome
pnpm knip:check      # unused files / deps / exports
pnpm test:unit       # vitest: parser + aggregation against the fixtures in src/renderer/gpu/__tests__/fixtures
pnpm build           # electron-vite → out/, then a Main-bundle smoke test
pnpm pack            # prepack runs the build, then writes the .tgz in the repo root
```

### Install a local build in Freelens

```sh
pnpm pack
# → freelensapp-gpu-extension-<version>.tgz
```

Open Freelens → Extensions → paste the absolute path of the `.tgz` (or drag it into the window) → **Install** →
enable. Rebuild + reinstall to iterate, then fully restart Freelens.

### Try it without a GPU

Any pod named like `*dcgm-exporter*` that serves a DCGM-style Prometheus text file on `/metrics` (nginx + a
ConfigMap on a kind cluster works) is discovered and rendered exactly like the real DaemonSet. The fixture files under
`src/renderer/gpu/__tests__/fixtures/` are valid input.

### How it works

See [ARCHITECTURE.md](ARCHITECTURE.md). In short: `podsApi.list()` → keyword filter → probe each candidate's
`/metrics` through `/api-kube/api/v1/namespaces/<ns>/pods/<pod>:<port>/proxy/metrics` → classify by content → parse with
a tiny built-in Prometheus text parser → aggregate per pod and per device (a port of kubectl-gpugo's scraper) → a MobX
store polls every 20 s while a GPU view is mounted.

## Releasing

See [docs/publishing.md](docs/publishing.md): version bump → `vX.Y.Z` tag → CI stages the package on npm via Trusted
Publishing and creates the GitHub Release → a maintainer approves the staged version.

## Repository layout

- `src/renderer/gpu/` — `scraper.ts` (discovery, pod-proxy fetch), `prom.ts` (parser), `aggregate.ts` (attribution
  rules, shared with kubectl-gpugo), `store.ts` (polling, history, derived views), `types.ts`, `__tests__/`.
- `src/renderer/components/` — `DataGrid`, `PageShell`, utilisation bar, drawer sections, styles.
- `src/renderer/pages/` — Pods, GPUs, Idle & waste, Allocation, Exporters.
- `src/main/index.ts` — empty Main entry (required by Freelens).
- `scripts/smoke-main.cjs` — loads the built Main bundle with stubbed host globals after every build.

## Limitations

- Time-slicing (not MIG) on dcgm-exporter reports identical per-GPU numbers for every pod sharing the card; only a per-process exporter can split those.
- Auto-discovery is keyword + content based. An exporter with an unusual name **and** unusual metric families is skipped.
- Freelens must be able to reach the pod-proxy subresource with your kubeconfig's RBAC; restricted tokens without `pods/proxy` cannot work.

## License

MIT
