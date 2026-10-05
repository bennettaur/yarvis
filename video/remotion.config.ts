import path from "node:path";
import { Config } from "@remotion/cli/config";
import { enableTailwind } from "@remotion/tailwind-v4";

Config.setVideoImageFormat("jpeg");
Config.setJpegQuality(92);
Config.overrideWebpackConfig((config) => {
  const withTailwind = enableTailwind(config);
  return {
    ...withTailwind,
    resolve: {
      ...withTailwind.resolve,
      // The scenes import components from the app in ../src, which would
      // otherwise resolve React from the app's node_modules. Two copies of
      // React break hooks, so this package's copy is searched first.
      modules: [path.resolve(process.cwd(), "node_modules"), "node_modules"],
    },
  };
});
