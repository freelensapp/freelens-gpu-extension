import { builtinModules } from "node:module";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { globalExternals } from "./build/global-externals.js";

// Provided by the Node/Electron runtime inside Freelens; never bundle them.
const runtimeExternals = ["electron", /^electron\//, ...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

// Legacy (experimentalDecorators) MobX decorators are compiled by oxc; @vitejs/plugin-react 6 has no babel option.
const decorators = {
  legacy: true,
  emitDecoratorMetadata: true,
};

export default defineConfig({
  main: {
    build: {
      lib: {
        entry: resolve(__dirname, "src/main/index.ts"),
        formats: ["cjs"], // Freelens 1.x extensions are CommonJS
      },
      rolldownOptions: {
        external: runtimeExternals,
        output: {
          exports: "named",
          preserveModules: (process.env.VITE_PRESERVE_MODULES ?? "true") === "true",
          preserveModulesRoot: "src/main",
        },
      },
      sourcemap: true,
    },
    oxc: { decorator: decorators },
    plugins: [
      react(),
      globalExternals({
        "@freelensapp/extensions": "global.LensExtensions",
        mobx: "global.Mobx",
      }),
    ],
  },
  // The renderer bundle is built with the preload settings so it can use
  // Node modules; that is how Freelens loads extension renderers.
  preload: {
    build: {
      lib: {
        entry: resolve(__dirname, "src/renderer/index.tsx"),
        formats: ["cjs"],
      },
      outDir: "out/renderer",
      rolldownOptions: {
        external: runtimeExternals,
        output: {
          exports: "named",
          preserveModules: (process.env.VITE_PRESERVE_MODULES ?? "true") === "true",
          preserveModulesRoot: "src/renderer",
        },
      },
      sourcemap: true,
    },
    oxc: { decorator: decorators },
    plugins: [
      react(),
      globalExternals({
        // Provided by the host app as globals; must not be bundled twice.
        "@freelensapp/extensions": "global.LensExtensions",
        mobx: "global.Mobx",
        "mobx-react": "global.MobxReact",
        react: "global.React",
        "react-dom": "global.ReactDom",
        "react-router-dom": "global.ReactRouterDom",
        "react/jsx-runtime": "global.ReactJsxRuntime",
      }),
    ],
  },
});
