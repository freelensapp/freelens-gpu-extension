#!/usr/bin/env bash
# Waits for the pods of the fake GPU fixture (up.sh) and checks the exporters
# through the apiserver pod proxy, the same path the extension uses.
set -euo pipefail

log() { echo "[gpu-fixture] $*"; }

for p in gpu-operator/nvidia-dcgm-exporter-7xk2p gpu-operator/nvidia-dcgm-exporter-m9q4t ml/vllm-0 embeddings/tei-7d9f-x1 \
  it-dgx1/transcription-0 it-dgx1/transcription-1 it-dgx2/ocr-0 it-dgx2/vllm-0; do
  kubectl -n "${p%%/*}" wait --for=condition=Ready "pod/${p##*/}" --timeout=300s >/dev/null
done

check_lines() {
  local what="$1" raw="$2" pattern="$3" count
  count="$(kubectl get --raw "$raw" | grep -c "$pattern" || true)"
  log "$what: $count lines"
  [ "$count" -gt 0 ] || { echo "no $pattern lines served at $raw" >&2; exit 1; }
}
check_lines "whole-GPU exporter" /api/v1/namespaces/gpu-operator/pods/nvidia-dcgm-exporter-7xk2p:9400/proxy/metrics '^DCGM_FI_DEV_'
check_lines "MIG exporter" /api/v1/namespaces/gpu-operator/pods/nvidia-dcgm-exporter-m9q4t:9400/proxy/metrics '^DCGM_FI_'
check_lines "vLLM server" /api/v1/namespaces/ml/pods/vllm-0:8000/proxy/metrics '^vllm:'
kubectl get pods -A -o wide | grep -E 'gpu-operator|^ml |embeddings|it-dgx|research' || true
