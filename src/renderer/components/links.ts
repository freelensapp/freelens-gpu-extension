import { Renderer } from "@freelensapp/extensions";

/** Kube API selfLinks for the objects the GPU views mention; opened in Freelens' own details panel. */
export const podLink = (namespace: string, name: string): string | undefined =>
  namespace && name && namespace !== "-" ? `/api/v1/namespaces/${namespace}/pods/${name}` : undefined;

export const nodeLink = (name: string): string | undefined => (name ? `/api/v1/nodes/${name}` : undefined);

export const namespaceLink = (name: string): string | undefined => (name ? `/api/v1/namespaces/${name}` : undefined);

export const serviceLink = (namespace: string, name: string): string | undefined =>
  namespace && name ? `/api/v1/namespaces/${namespace}/services/${name}` : undefined;

/** "ns/pod" as used in pod lists. */
export const podRefLink = (ref: string): string | undefined => {
  const i = ref.indexOf("/");
  return i > 0 ? podLink(ref.slice(0, i), ref.slice(i + 1)) : undefined;
};

export function openDetails(selfLink: string): void {
  Renderer.Navigation.showDetails(selfLink, true);
}
