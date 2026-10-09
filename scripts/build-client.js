require("./build-item-icons.js");
const esbuild = require("esbuild");
const options = {
  entryPoints: [
    "client/site.ts",
    "client/salonClient.ts",
    "client/discussionClient.ts",
    "client/jeuClient.ts",
  ],
  outdir: "public/js",
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "iife",
  minify: true,
};
const drawingOptions = {
  entryPoints: ["games/dessin/client/main.ts"],
  outfile: "games/dessin/public/app.js",
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  minify: true,
};
if (process.argv.includes("--watch"))
  Promise.all(
    [options, drawingOptions].map(async (configuration) => {
      const context = await esbuild.context(configuration);
      await context.watch();
    }),
  ).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
else {
  esbuild.buildSync(options);
  esbuild.buildSync(drawingOptions);
}
