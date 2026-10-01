# Fake GPU fixture

Disposable GPUs for the Playwright integration tests that CI runs inside a packaged Freelens on kind
(`.github/workflows/integration-tests.yaml`). No GPU is involved:

- `kind.yaml`: a two-node cluster; `up.sh` advertises 4 whole GPUs on the worker and MIG slices
  (`mig-1g.10gb` x7, `mig-3g.40gb` x1) on the control plane by patching the node status.
- `pods.yaml`: two "dcgm-exporter" pods (busybox httpd serving the exporter fixtures of
  `src/renderer/gpu/__tests__/fixtures/` from ConfigMaps), a vLLM "server" for the Inference view,
  workload pods named as in the fixtures that request the fake resources, and two pods that can never
  be scheduled for the Pending view.
- `dcgm-xid-extra.prom`: XID health lines appended to the whole-GPU exporter fixture (an application XID
  on the card of `tei`, a hardware XID on the idle card).

Locally, with Docker and kind:

```sh
kind create cluster --name freelens --config integration/fixtures/gpu/kind.yaml
integration/fixtures/gpu/up.sh && integration/fixtures/gpu/wait.sh
# install the packed extension in Freelens, open the cluster and the GPU views
integration/fixtures/gpu/down.sh
kind delete cluster --name freelens
```

`CLUSTER=<name>` selects another kind cluster; the node names follow kind's `<name>-worker` and
`<name>-control-plane` convention.
