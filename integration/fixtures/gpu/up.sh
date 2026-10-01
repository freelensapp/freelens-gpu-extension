#!/usr/bin/env bash
# Fake GPU fixture for the Playwright integration tests. No GPU is needed:
#  - extended resources (nvidia.com/gpu, nvidia.com/mig-*) are patched into the node status;
#  - the "dcgm-exporter" pods are busybox httpd servers for the exporter fixtures of the unit tests;
#  - workload pods named as in those fixtures request the fake resources;
#  - two pods that can never be scheduled feed the Pending view.
# Applies everything and returns; wait.sh waits for readiness. Idempotent.
# Env: CLUSTER (kind cluster name, default freelens), BUSYBOX, FIXTURES, KUBECONFIG.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CLUSTER="${CLUSTER:-freelens}"
FIXTURES="${FIXTURES:-$HERE/../../../src/renderer/gpu/__tests__/fixtures}"
BUSYBOX="${BUSYBOX:-busybox:1.37.0}"
WHOLE_NODE="${WHOLE_NODE:-$CLUSTER-worker}"
MIG_NODE="${MIG_NODE:-$CLUSTER-control-plane}"
STATE="$(mktemp -d)"
trap 'rm -rf "$STATE"' EXIT

log() { echo "[gpu-fixture] $*"; }

[ -d "$FIXTURES" ] || { echo "fixtures not found: $FIXTURES" >&2; exit 1; }
kubectl get node "$WHOLE_NODE" "$MIG_NODE" >/dev/null

# Pull the image inside the nodes first, so the pods do not wait on the registry.
if command -v docker >/dev/null 2>&1 && command -v kind >/dev/null 2>&1; then
  for node in $(kind get nodes --name "$CLUSTER" 2>/dev/null); do
    docker exec "$node" crictl pull "docker.io/library/$BUSYBOX" >/dev/null 2>&1 || true
  done
fi

log "advertising fake GPU resources: 4 whole GPUs on $WHOLE_NODE, MIG slices on $MIG_NODE"
kubectl patch node "$WHOLE_NODE" --subresource=status --type=merge \
  -p '{"status":{"capacity":{"nvidia.com/gpu":"4"}}}' >/dev/null
kubectl patch node "$MIG_NODE" --subresource=status --type=merge \
  -p '{"status":{"capacity":{"nvidia.com/mig-1g.10gb":"7","nvidia.com/mig-3g.40gb":"1"}}}' >/dev/null
kubectl label node "$WHOLE_NODE" nvidia.com/gpu.present=true nvidia.com/gpu.product=NVIDIA-A100-SXM4-80GB --overwrite >/dev/null
kubectl label node "$MIG_NODE" nvidia.com/gpu.present=true nvidia.com/mig.strategy=mixed --overwrite >/dev/null

log "creating the namespaces and the exporter ConfigMaps from the unit-test fixtures"
for ns in gpu-operator ml embeddings it-dgx1 it-dgx2 research; do
  kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
done
# Whole GPUs: the author's fixture plus four XID health lines (none on the cards of
# vllm-0, an application XID on the card of tei, a hardware XID on the idle card).
cat "$FIXTURES/dcgm_pod_labels.prom" "$HERE/dcgm-xid-extra.prom" > "$STATE/metrics-whole"
kubectl -n gpu-operator create configmap dcgm-whole --from-file=metrics="$STATE/metrics-whole" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n gpu-operator create configmap dcgm-mig --from-file=metrics="$FIXTURES/dcgm_mig.prom" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n ml create configmap vllm-metrics --from-file=metrics="$FIXTURES/vllm_v1_idle.prom" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

log "creating the pods"
sed -e "s|__WHOLE_NODE__|$WHOLE_NODE|g" -e "s|__MIG_NODE__|$MIG_NODE|g" -e "s|__BUSYBOX__|$BUSYBOX|g" \
  "$HERE/pods.yaml" | kubectl apply -f - >/dev/null
log "applied; run wait.sh before the tests"
