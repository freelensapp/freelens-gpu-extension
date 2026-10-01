import { Main } from "@freelensapp/extensions";

/** No main-process behaviour yet; everything runs in the cluster frame. */
export default class GpuExtensionMain extends Main.LensExtension {}
