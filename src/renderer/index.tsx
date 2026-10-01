import { Renderer } from "@freelensapp/extensions";
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

export default class GpuExtensionRenderer extends Renderer.LensExtension {
  clusterPages = [
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

  kubeObjectDetailItems = [
    {
      kind: "Pod",
      apiVersions: ["v1"],
      priority: 5,
      components: {
        Details: (props: Renderer.Component.KubeObjectDetailsProps<any>) => <PodGpuDetails {...props} />,
      },
    },
    {
      kind: "Node",
      apiVersions: ["v1"],
      priority: 5,
      components: {
        Details: (props: Renderer.Component.KubeObjectDetailsProps<any>) => <NodeGpuDetails {...props} />,
      },
    },
  ];
}
