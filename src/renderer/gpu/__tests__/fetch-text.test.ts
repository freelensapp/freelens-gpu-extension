import { afterEach, describe, expect, it, vi } from "vitest";

// The host API the default deps use: KubeJsonApi.forCluster and Util.fetch, set per test.
const host = vi.hoisted(() => ({
  K8sApi: { KubeJsonApi: {} as { forCluster?: unknown } },
  Util: { fetch: undefined as unknown },
}));
vi.mock("@freelensapp/extensions", () => ({ Common: { logger: { info() {}, warn() {} } }, Renderer: host }));

const { defaultDeps } = await import("../scraper");

const response = (status: number, body: string, statusText = "") => new Response(body, { status, statusText });

afterEach(() => {
  host.K8sApi.KubeJsonApi = {};
  host.Util.fetch = undefined;
});

describe("defaultDeps.fetchText", () => {
  it("reads the body through KubeJsonApi.forCluster as text, with the abort signal", async () => {
    const getResponse = vi.fn(async () => response(200, "DCGM_FI_DEV_GPU_UTIL 3\n"));
    const forCluster = vi.fn(() => ({ getResponse }));
    const fetch = vi.fn();
    host.K8sApi.KubeJsonApi = { forCluster };
    host.Util.fetch = fetch;

    await expect(
      defaultDeps.fetchText("c1", "/api/v1/namespaces/gpu/pods/dcgm:9400/proxy/metrics", 1000),
    ).resolves.toBe("DCGM_FI_DEV_GPU_UTIL 3\n");
    expect(forCluster).toHaveBeenCalledWith("c1");
    expect(getResponse).toHaveBeenCalledWith("/api/v1/namespaces/gpu/pods/dcgm:9400/proxy/metrics", undefined, {
      signal: expect.any(AbortSignal),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("turns a non-2xx answer into the HTTP <code> error, with no second request", async () => {
    const getResponse = vi.fn(async () => response(404, "404 page not found", "Not Found"));
    const fetch = vi.fn();
    host.K8sApi.KubeJsonApi = { forCluster: () => ({ getResponse }) };
    host.Util.fetch = fetch;

    await expect(defaultDeps.fetchText("c1", "/apis/resource.k8s.io/v1/resourceslices", 1000)).rejects.toThrow(
      /^HTTP 404 Not Found for \/apis\/resource\.k8s\.io\/v1\/resourceslices$/,
    );
    expect(getResponse).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a forbidden answer as HTTP 403, which discovery does not take for a missing API", async () => {
    host.K8sApi.KubeJsonApi = { forCluster: () => ({ getResponse: async () => response(403, '{"kind":"Status"}') }) };

    await expect(defaultDeps.fetchText("c1", "/apis/resource.k8s.io/v1/resourceclaims", 1000)).rejects.toThrow(
      /^HTTP 403 /,
    );
  });

  it("goes to /api-kube through Util.fetch only when the host has no forCluster", async () => {
    const fetch = vi.fn(async () => response(200, "ok"));
    host.Util.fetch = fetch;

    await expect(defaultDeps.fetchText("c1", "/api/v1/pods", 1000)).resolves.toBe("ok");
    expect(fetch).toHaveBeenCalledWith("/api-kube/api/v1/pods", { signal: expect.any(AbortSignal) });

    fetch.mockResolvedValueOnce(response(503, "", "Service Unavailable"));
    await expect(defaultDeps.fetchText("c1", "/api/v1/pods", 1000)).rejects.toThrow(/^HTTP 503 /);
  });

  it("aborts the request when the timeout passes", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const getResponse = vi.fn(
        (_path: string, _params: undefined, init: { signal: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            signal = init.signal;
            init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      );
      host.K8sApi.KubeJsonApi = { forCluster: () => ({ getResponse }) };

      const pending = defaultDeps.fetchText("c1", "/api/v1/pods", 50);
      const assertion = expect(pending).rejects.toThrow(/aborted/);
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
