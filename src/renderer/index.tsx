import { Renderer } from "@freelensapp/extensions";
import { withDetailsErrorBoundary } from "./components/error-boundary";
import { GpuIcon } from "./components/gpu-icon";
import { NodeGpuDetails } from "./components/node-gpu-details";
import { PodGpuDetails } from "./components/pod-gpu-details";
import { AllocationPage } from "./pages/allocation-page";
import { DevicesPage } from "./pages/devices-page";
import { ExportersPage } from "./pages/exporters-page";
import { InferencePage } from "./pages/inference-page";
import { NamespacesPage } from "./pages/namespaces-page";
import { PendingPage } from "./pages/pending-page";
import { PodsPage } from "./pages/pods-page";
import { WastePage } from "./pages/waste-page";

import "./styles.scss";

export default class GpuExtensionRenderer extends Renderer.LensExtension {
  // The host wraps every cluster page in an error boundary of its own ("App crash at <path>", with the stacks and a
  // Back button), so the pages need none here.
  clusterPages: Renderer.LensExtension["clusterPages"] = [
    { id: "gpu-pods", components: { Page: () => <PodsPage extension={this} /> } },
    { id: "gpu-namespaces", components: { Page: () => <NamespacesPage extension={this} /> } },
    { id: "gpu-inference", components: { Page: () => <InferencePage extension={this} /> } },
    { id: "gpu-devices", components: { Page: () => <DevicesPage extension={this} /> } },
    { id: "gpu-idle", components: { Page: () => <WastePage extension={this} /> } },
    { id: "gpu-allocation", components: { Page: () => <AllocationPage extension={this} /> } },
    { id: "gpu-pending", components: { Page: () => <PendingPage extension={this} /> } },
    { id: "gpu-exporters", components: { Page: () => <ExportersPage extension={this} /> } },
  ];

  clusterPageMenus = [
    { id: "gpu", title: "GPU", components: { Icon: GpuIcon } },
    { id: "gpu-pods", parentId: "gpu", target: { pageId: "gpu-pods" }, title: "Pods", components: {} },
    {
      id: "gpu-namespaces",
      parentId: "gpu",
      target: { pageId: "gpu-namespaces" },
      title: "Namespaces",
      components: {},
    },
    {
      id: "gpu-inference",
      parentId: "gpu",
      target: { pageId: "gpu-inference" },
      title: "Inference",
      components: {},
    },
    { id: "gpu-devices", parentId: "gpu", target: { pageId: "gpu-devices" }, title: "GPUs", components: {} },
    { id: "gpu-idle", parentId: "gpu", target: { pageId: "gpu-idle" }, title: "Idle & waste", components: {} },
    {
      id: "gpu-allocation",
      parentId: "gpu",
      target: { pageId: "gpu-allocation" },
      title: "Allocation",
      components: {},
    },
    { id: "gpu-pending", parentId: "gpu", target: { pageId: "gpu-pending" }, title: "Pending", components: {} },
    { id: "gpu-exporters", parentId: "gpu", target: { pageId: "gpu-exporters" }, title: "Exporters", components: {} },
  ];

  kubeObjectDetailItems: Renderer.LensExtension["kubeObjectDetailItems"] = [
    Renderer.K8sApi.detailsFor(Renderer.K8sApi.Pod, { priority: 5, Details: PodGpuDetails }),
    Renderer.K8sApi.detailsFor(Renderer.K8sApi.Node, { priority: 5, Details: NodeGpuDetails }),
  ].map((registration) => withDetailsErrorBoundary(this, registration));
}
