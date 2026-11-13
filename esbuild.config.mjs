import esbuild from "esbuild";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";
// Bundle the "buffer" polyfill (Android has no Node built-ins); leave the rest to Electron.
const nodeBuiltins = builtinModules.filter((m) => m !== "buffer");

const ctx = await esbuild.context({
  entryPoints: ["src/plugin/main.ts"],
  bundle: true,
  outfile: "dist/plugin/main.js",
  format: "cjs",
  platform: "browser",
  target: "es2022",
  // Node built-ins are only used by src/platform/* which loads on desktop only.
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...nodeBuiltins, ...nodeBuiltins.map((m) => `node:${m}`)],
  inject: ["src/plugin/buffer-shim.js"],
  define: { "process.env.NODE_ENV": prod ? '"production"' : '"development"' },
  sourcemap: prod ? false : "inline",
  minify: prod,
  treeShaking: true,
  logLevel: "info",
});
if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
