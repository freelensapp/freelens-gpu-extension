# Architecture

Everything runs in the **Renderer** (the cluster frame). There is no Main-process engine and no IPC: the data source
is the kube-apiserver itself, reached through Freelens' proxy, so the renderer can do the whole job.

| Layer | Location | Role |
| --- | --- | --- |
| Entry | `src/renderer/index.tsx` | Registers the GPU sidebar group, five cluster pages, and Pod/Node detail items. |
| Data | `src/renderer/gpu/` | `scraper.ts` (discovery + pod-proxy fetch), `prom.ts` (Prometheus text parser), `aggregate.ts` (attribution rules), `store.ts` (MobX store, polling, history, derived views), `types.ts`. |
| UI | `src/renderer/components/`, `src/renderer/pages/` | `DataGrid` (sortable/resizable CSS grid), `PageShell` (title, version, status, refresh, scrolling body), one page per view, drawer sections. |
| Main | `src/main/index.ts` | Empty `Main.LensExtension`; present because Freelens loads both entry points. |

## Data path

```text
podsApi.list()  ──▶ candidates (Running, name/image/labels ∋ dcgm|gpu|nvidia|cuda, metrics port)
                        │  fetch(`/api-kube/api/v1/namespaces/<ns>/pods/<pod>:<port>/proxy/metrics`)
                        ▼
                classifyMetrics(body) ──▶ ExporterPod{kind: dcgm | enricher}     (cached 60 s)
                        │
        every 20 s      ▼
                fetch /metrics for each exporter ──▶ parsePrometheusText ──▶ Families
                        │
                        ├─ buildEnricherRows / aggregateByPod / aggregateByGPU  ──▶ PodGPU[]   (Pods view, drawers)
                        ├─ aggregateDevicesDcgm / aggregateDevicesEnricher     ──▶ GpuDevice[] (GPUs view)
                        └─ requestedByNode (pod nvidia.com/gpu limits)          ┐
                nodesApi.list() capacity / allocatable                          ┴──▶ AllocationRow[] (Allocation view)
                store.history (per pod, 6 h, in memory)                        ──▶ IdleRow[]      (Idle & waste view)
                scraper.lastProbes + per-exporter latency/bytes/error           ──▶ Exporters view
```

## Attribution rules (shared with kubectl-gpugo)

1. A **per-process exporter** (`gpu_process_memory_bytes{namespace,pod,uuid,...}`) wins when present: it attributes
   even workloads that bypass the device plugin via `NVIDIA_VISIBLE_DEVICES=all`. Power is split per pod by VRAM share.
2. **dcgm-exporter with pod labels** (`--kubernetes`): one row per pod; MIG slices are keyed `gpu:GPU_I_ID` so pods on
   different slices of one card stay separate. `DCGM_FI_DEV_GPU_UTIL` is the util source; `DCGM_FI_PROF_GR_ENGINE_ACTIVE`
   ×100 is used only for a GPU that has no `GPU_UTIL` (MIG). Non-MIG cards with DCP metrics emit both, so they are never
   added together.
3. **dcgm-exporter without pod labels**: one row per (node, GPU) with the node's GPU-requesting pods as hints.

Rows come from the per-process exporter on the nodes where it reports and from DCGM on every other node, so mixed node
pools keep all their pods.

Devices take the **max** of repeated gauges (DCGM repeats a device's line once per attributed pod), never the sum.
Power totals (GPUs subtitle, Node drawer, Allocation) count each **physical card once**: on MIG every slice repeats its
card's `DCGM_FI_DEV_POWER_USAGE`.

The node of a DCGM sample is the exporter pod's `spec.nodeName`; the `Hostname` label is only a fallback, because it is
the container hostname (the exporter pod name) unless the DaemonSet sets `NODE_NAME`.

"GPUs requested" and node capacity count `nvidia.com/gpu` **plus** every `nvidia.com/mig-*` resource
(`mig.strategy=mixed`), in devices, which is the same unit the exporters report. Time-slicing replicas renamed to
`*.shared` are not devices and are left out of the counts, but a pod requesting one still counts as a GPU pod.

## Why the relative `/api-kube` fetch

Inside a cluster frame the window origin is Freelens' proxy for that cluster and `/api-kube/*` is forwarded to the
kube-apiserver with the kubeconfig's credentials. The typed `Renderer.K8sApi.KubeJsonApi.forCluster` exists in the
1.10.3 typings but not at runtime, so it is only used when actually present.

## Freelens v2 readiness (notes, 2026-09-24)

Freelens v2 (React 19, ESM renderer, new extension API global) is announced but unreleased: the latest release is
v1.10.3, and the host does not yet publish the shared singletons its own migration guide tells extensions to use
([freelens#2450](https://github.com/freelensapp/freelens/issues/2450)). Nothing can be tested against v2 yet, so this is
a checklist, not a port. Source: `docs/v2-extension-migration.md` and `docs/v2-extension-api.md` in freelensapp/freelens.

v2 refuses every v1 extension at discovery (`engines.freelens: ^1.x` yields `<2.0.0-0`), so the port is a **new major**
of this extension, with 0.3.x staying the v1 line.

| # | v2 requirement | This extension today | Work |
| --- | --- | --- | --- |
| 1 | `engines.freelens: ^2.0.0` | `^1.8.0` | bump in the v2 major only |
| 2 | Renderer entry is **ESM**, loaded by URL (main may stay CJS) | renderer built as CJS via electron-vite `preload` | switch renderer `formats` to `es`, set `"type": "module"` or `.mjs` |
| 3 | Host singletons come from `globalThis.FreelensExtensionApi.<Name>` (`React`, `ReactDom`, `ReactJsxRuntime`, `Mobx`, `MobxReact`, ...); `@freelensapp/extensions` is bundled, no longer external | `build/global-externals.js` maps to `global.React` etc. and externalises `@freelensapp/extensions` | retarget the plugin, drop the extensions id from the map |
| 4 | React **19** (`react`, `react-dom`, `@types/react*` as devDependencies) | React 17 | bump; the code is function components + hooks only, with no `ReactDOM.render`, `findDOMNode` or string refs, so low risk |
| 5 | mobx 6.15 host instance; a second mobx copy fails **silently** (reactions never fire) | mobx 6.13 / mobx-react 7 decorators + `makeObservable` | bump; assert that `gpuStore.snapshot` updates re-render a page, don't eyeball it |
| 6 | tsconfig `lib: ["ES2024","DOM","DOM.Iterable"]`, `skipLibCheck`, `moduleResolution: bundler` | `bundler` since TypeScript 7 (inherited from `@electron-toolkit/tsconfig`); `paths` map `@freelensapp/core/{main,renderer}` to their `.d.ts` because the core exports map has no types | check `lib` / `skipLibCheck` only |
| 7 | `Renderer.Util.fetch` for renderer HTTP; `KubeJsonApi.forCluster` stays supported; responses are the structural `FetchResponse` | relative `fetch('/api-kube'+path)`, probing for `forCluster` | prefer `forCluster` (documented in v2), else `Renderer.Util.fetch`; we only read `ok`/`status`/`statusText`/`text()`, all in `FetchResponse` |
| 8 | Stylesheets imported normally, one CSS asset next to the entry | CSS string injected via `<style>` | optional: move `gpuStyles` to a `.css` import. Theme tokens (`var(--textColorPrimary)` …) remain the contract, and no removed `flexbox.scss` classes are used |
| 9 | `Renderer.Component.List` and the `react-router` re-exports removed | not used (own `DataGrid`) | none |
| 10 | Component/namespace renames (table not filled yet, [freelens#2451](https://github.com/freelensapp/freelens/issues/2451)) | uses `Button`, `Spinner`, `DrawerTitle`, `K8sApi.podsApi/nodesApi`, `Catalog.getActiveCluster`, `Common.logger` | re-check once the rename table lands |

Start the port when freelens#2450 closes and a v2 pre-release exists to load it in.
