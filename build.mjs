import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: {
    background: "src/background.js",
  },
  bundle: true,
  format: "iife",
  target: ["safari16"],
  outdir: "extension",
  minify: true,
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
