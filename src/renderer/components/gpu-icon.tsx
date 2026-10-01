import { Renderer } from "@freelensapp/extensions";

const { Icon } = Renderer.Component;

export function GpuIcon(props: Renderer.Component.IconProps) {
  return <Icon {...props} material="memory" />;
}
