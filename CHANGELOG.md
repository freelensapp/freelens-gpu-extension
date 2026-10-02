# Changelog

## Unreleased

- Fix: on a cluster without exporters the whole cluster was listed again every 20 s (pods, services, nodes), also
  when only a Pod or Node drawer was open. An empty discovery and a failed Prometheus search are now cached for 60 s
  like a successful one, nodes are listed with the discovery instead of with every scrape, and the drawers poll only
  for a pod that can use a GPU (or on a cluster known to have GPUs) and for a node that advertises one (#8).

## 0.8.0

- Moved to the freelensapp organization as `@freelensapp/gpu-extension`: the organization workflows (release with
  provenance, SBOM and checksums, Claude, npm audit and dedupe, trunk and biome upgrades), Playwright integration tests
  inside a packaged Freelens on kind with a fake GPU fixture (`integration/fixtures/gpu/`), agent guides.
- Supersedes `@tal-naeh/freelens-gpu-extension`: uninstall the old package before installing this one.

## 0.7.1

- Fix: pods on MIG slices were each charged their whole card's power (DCGM reports the card's draw on every slice),
  so the Pods view showed ~104 W per 1g pod and the Namespaces view summed to several times the node's real draw
  (~3,000 W vs 804 W on an 8× A100 node). Pod rows now get each slice's share of the card's power, weighted by the
  slice's compute size (1g of a fully partitioned A100 = 1/7, 3g = 3/7). The GPUs view keeps the card draw per slice,
  with a tooltip saying so.

## 0.7.0

- **Inference** view: vLLM servers next to their GPUs — model, KV cache, running / waiting requests, generated tokens/s,
  recent time to first token, prefix-cache hit rate, new preemptions and errors, and a status (*saturated* when the KV
  cache is ≥ 90% with a queue). Found among Running pods that request a GPU or look like an inference server, by the
  content of their `/metrics`; works without any GPU exporter. Supports vLLM V1 (`kv_cache_usage_perc`) and earlier
  (`gpu_cache_usage_perc`); servers still loading their model are picked up once ready. Idle & waste marks vLLM pods
  (they reserve most VRAM by design) and Copy Markdown includes the servers.
- **XID meanings**: health explains the code (79 = fallen off the bus, 48 = double-bit ECC, …) and says "last XID",
  since DCGM keeps the last code seen. Application-caused XIDs (13, 31, 43, 45) are warnings, not hardware failures.
- **Throttle reasons**: hardware slowdown, thermal slowdown and power brake from DCGM's clock-event bitmask show as
  warnings; a software power cap is configuration and not flagged; throttle data alone never counts as "healthy".
- **Pod-level health**: the Pods view marks pods whose GPU (for a MIG slice, its physical card) is unhealthy, and the Pod
  drawer spells it out.

## 0.6.0

- **Open from any table**: pod, node and namespace names in every GPU view open Freelens' own details panel.
- **Copy snapshot**: *Copy JSON* / *Copy Markdown* on every page — the whole cluster's GPU state (health issues and
  waiting pods first, then allocation, namespaces, pods, exporters) for Slack / Jira during an incident.
- **Pinned targets** (Exporters page, per cluster): `namespace/pod-prefix:port` for exporter pods discovery misses
  (matched by name prefix, so DaemonSet restarts keep working) and `namespace/svc/name:port` for a Prometheus.
- **Prometheus fallback**: when no exporter pod answers, the same metrics are read from a Prometheus / Thanos /
  VictoriaMetrics / Mimir query API in the cluster through the service proxy — found automatically (alertmanager,
  operators and exporters skipped) or pinned — with Prometheus' label rewriting undone (`exported_*`, series stamped
  with the exporter pod, HA duplicates) and the service-discovery node label trusted over DCGM's `Hostname`. Verified
  against a live kube-prometheus-style setup: identical devices, pods and namespaces to a direct scrape.
- **Node health**: Allocation *Health* column and a Node drawer badge — the node's worst device, red whenever the
  device plugin withdrew GPUs even with no health gauges, and "OK (1 of 48 report)" to show coverage.
- Configurable colour thresholds were considered and left out (no user demand found).

## 0.5.0

Four new capabilities, chosen from what Kubernetes GPU users ask for most (dcgm-exporter / device-plugin / GPU Operator
issues, Lens and k9s issues, KubeCon talks). 0.4.0 was never published; its features ship here.

- **Pending** view: pods waiting for a GPU, with the scheduler's message and a *Why* for requests that can never be
  scheduled as written (a resource no node offers, `nvidia.com/gpu` on a MIG-partitioned cluster → request a slice,
  more devices than any single node has).
- **Namespaces** view: per namespace, devices requested (per resource), devices in use, mean GPU %, VRAM held, VRAM held
  idle, pods waiting and power ("whose GPUs are these, and are they using them?").
- **Honest utilisation**: GPUs view gains *SM active*, *Tensor* and *Mem BW* from `DCGM_FI_PROF_*` (with a notice when
  dcgm-exporter runs without them: "GPU %" is kernel time only). Pods view badges rows whose numbers are device-level:
  `shared ×N` when several pods sit on one device, `time-sliced` on nodes with `nvidia.com/gpu.replicas` > 1.
- **GPU health**: GPUs view *Health* from `XID_ERRORS`, `ECC_DBE_VOL_TOTAL`, `ROW_REMAP_FAILURE` (bad) and
  `UNCORRECTABLE_REMAPPED_ROWS` (warn); "not exported" when a device reports none of them (MIG slices never do) instead
  of a reassuring OK. Allocation gains *Unhealthy* (capacity − allocatable) and *MIG free* (free slices per profile);
  the Node drawer lists devices with issues.
- Pending and Namespaces work from the pod list alone, so they still show data on a cluster whose GPU exporter is
  missing or failing. Requested / MIG free count pods already bound to a node but still starting, as the scheduler does.
- Tests: a redacted real capture of an 8× A100 MIG-mixed dcgm-exporter is now a fixture (48 devices, 805 W, 29 pods).
- Toolchain (no runtime change): TypeScript 7, pnpm 12 (`allowBuilds`), Vite 8.3, Vitest 5, knip 6.38, biome 2.5;
  dropped the dead `@babel/plugin-proposal-decorators` option; Renovate waits a day before opening update PRs.

## 0.3.5

- Fix: time-slicing replicas (`nvidia.com/gpu.shared`, `nvidia.com/mig-*.shared`) are no longer counted as extra devices
  in node capacity / allocatable or in "Requested", which would inflate Allocation on time-sliced nodes. Pods requesting
  them still count as GPU pods (requesting-pods list, fallback-mode hints).
- Verified 0.3.4 against a live DGX A100 (47 MIG slices + 1 whole GPU): power total 805 W (was 5,033 W summed per slice),
  Allocation capacity 48 / requested 29 (was 1 / 0).

## 0.3.4

- Fix: pod GPU % no longer double-counts on non-MIG cards that emit both `DCGM_FI_DEV_GPU_UTIL` and
  `DCGM_FI_PROF_GR_ENGINE_ACTIVE` (DCP metrics on, e.g. A100/H100): `GPU_UTIL` wins, `GR_ENGINE_ACTIVE` only fills in
  for MIG slices. Previously such a pod could show well over 100%.
- Fix: power totals (GPUs subtitle, Node drawer, Allocation) count each physical card once instead of once per MIG slice.
- Fix: `mig.strategy=mixed` clusters: pod requests and node capacity/allocatable now include `nvidia.com/mig-*`
  resources, so Allocation, fallback-mode pod hints and "requested" are no longer zero on MIG nodes.
- Fix: DCGM samples are attributed to the exporter pod's node; the `Hostname` label (the exporter pod name unless
  `NODE_NAME` is set) is only a fallback. Node drawer and Allocation no longer miss or duplicate such nodes.
- Fix: clusters running both a per-process exporter and dcgm-exporter keep the pods on DCGM-only nodes in the Pods view.
- Fix: fallback-mode rows (no pod labels) on different nodes no longer share a React key, which could drop rows.
- Fix: "Peak in window" on Idle & waste reports the peak over the retained history, not only the idle stretch (which
  was always under 5%).
- Fix: a failed exporter scrape re-runs discovery on the next tick instead of reusing a stale pod for up to 60 s.
- UI: table row borders line up across columns (cells stretch to the row height; empty cells and GPU badges no longer
  shift their border up or down).
- UI: the Node drawer table hides the Node column instead of showing it empty.
- Deps: override `dompurify` (≥3.4.16) and `decode-uri-component` (≥0.5.0), dev-only transitive deps of
  `@freelensapp/core`, clearing the Dependabot alerts.
- Docs: ARCHITECTURE.md attribution rules updated; Freelens v2 readiness checklist.

## 0.3.3

- Fix: the heavier group separator in every table now follows the sorted column (namespace, node, physical GPU,
  model, MIG profile, GPU type, outcome) instead of disappearing as soon as the sort left the default column.
  Columns with unique or continuous values (pod name, percentages, sizes) draw no separators.

## 0.3.2

- Docs: screenshots of the GPUs (MIG) and Idle & waste views in the README.
- UI: wider default widths for the "VRAM held" and "Peak in window" columns so the headers are not truncated.

## 0.3.1

- Fix: LICENSE copyright holder.
- Docs: README Features and Usage sections; repo homepage points at the npm page.

## 0.3.0

First published release, as `@tal-naeh/freelens-gpu-extension` on npm.

- Sidebar group **GPU** with five views: Pods, GPUs (per device / MIG slice), Idle & waste, Allocation, Exporters.
- Per-device aggregation for dcgm-exporter (model, MIG profile, temperature) and per-process exporters.
- Rolling in-memory history drives the Idle & waste view ("idle for" from consecutive samples).
- Allocation joins `nvidia.com/gpu` capacity / allocatable with running pods' requests and measured busy devices.
- Exporters view exposes discovery probes, scrape latency, body size and errors.
- Shared DataGrid: click-to-sort, drag-to-resize (double-click resets, widths persisted), sticky header, hover text.
- Version badge in every page title.
- Fix: scrape uses the relative `/api-kube` proxy path; `KubeJsonApi.forCluster` is declared in the 1.10.3 typings but
  missing at runtime.
- GPU sections in the Pod and Node detail drawers.

## 0.1.0

- Initial local-only build: Pods table, pod/node drawer sections, pod-proxy scraping of dcgm-exporter and
  per-process exporters.
