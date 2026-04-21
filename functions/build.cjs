/* functions/build.cjs */
const path = require("path");
const { build } = require("esbuild");

const repoRoot  = path.resolve(__dirname, "..");
const sharedSrc = path.resolve(repoRoot, "packages", "shared", "src"); // or "dist" if you prefer built JS

(async () => {
  try {
    await build({
      entryPoints: ["src/index.ts"],
      bundle: true,
      platform: "node",
      target: "node22",
      format: "cjs",
      outdir: "lib",
      sourcemap: true,
      alias: {
        "@shared": sharedSrc,
      },
      external: [
        "firebase-admin",
        "firebase-functions",
        "@google-cloud/monitoring",   // ← leave as runtime dep
      ],
      logLevel: "info",
    });
    console.log("✓ functions bundled to lib/");
  } catch (err) {
    console.error("✗ esbuild failed");
    console.error(err);
    process.exit(1);
  }
})();