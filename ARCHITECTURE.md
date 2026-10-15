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
                        │  KubeJsonApi.forCluster(id).getResponse(`/api/v1/namespaces/<ns>/pods/<pod>:<port>/proxy/metrics`)
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

## Requests to the kube-apiserver

Every request goes through `Renderer.K8sApi.KubeJsonApi.forCluster(clusterId)`, the host's client for the cluster
of the frame, with its `getResponse`: the response comes back as it is, so a non-2xx answer becomes an
`HTTP <code> <statusText> for <path>` error, which discovery classifies (404 is a definite "no", anything else is
retried soon), and the body is read as text, since `/metrics` is not JSON. A failed request is not repeated. The
Freelens proxy authenticates the request by its authority and adds the kubeconfig's credentials, so `exec` plugins
and tokens work as they do for the rest of Freelens.

Freelens 1.x declared `forCluster` in the typings but not at runtime, so it is still probed before use. Only on a
host without it does the scraper fetch the relative `/api-kube/*` URL with `Renderer.Util.fetch`: inside a cluster
frame the window origin is the proxy for that cluster, and `/api-kube/*` goes to its kube-apiserver.

## Freelens v2

The extension targets the Freelens v2 extension API (`engines.freelens: ^2.0.0`) after 0.9.x, the last
release for Freelens 1.x, which refuses a v2 extension at discovery as v2 refuses a v1 one. The port followed
`docs/extensions/migrating-from-v1.md` of freelensapp/freelens and took the toolchain of
[freelens-example-extension](https://github.com/freelensapp/freelens-example-extension):

- ESM bundles built by Vite in library mode, `dist/main.js` and `dist/renderer.js`, with the host's React 19, mobx 7
  and mobx-react 10 read from `globalThis.FreelensExtensionApi` (`build/vite-plugin-host-modules.mjs`).
- `GpuStore` on standard decorators (`@observable accessor`, `@observableRef accessor`), lowered by
  `build/vite-plugin-standard-decorators.mjs`; `store.test.ts` checks that its fields are observable and that a
  reaction on a computed value fires.
- The stylesheet in `src/renderer/styles.scss`, compiled into `dist/renderer.css`, which the host links, instead of a
  `<style>` element rendered by every page and drawer.
- The Pod and Node drawer sections inside an error boundary of the extension, registered with
  `Renderer.K8sApi.detailsFor`: the nearest boundary of the host there is the whole cluster frame. Pages have none of
  their own, because the host wraps every cluster page in a boundary that shows the error with its stacks and a Back
  button.
- One TypeScript program per runtime environment, so a Node API in renderer code fails `pnpm type:check`.
