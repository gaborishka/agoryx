// Agoryx.app for this Mac: `npm --prefix desktop run dist` → desktop/release/ (an unsigned arm64 .app
// and .dmg). The app itself is the Electron shell; the Agoryx core rides along as plain files in
// Contents/Resources/agoryx, and the daemon runs that copy with the user's own node (docs/DESKTOP.md).
const { join } = require("node:path");

const root = join(__dirname, "..");

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "dev.agoryx.desktop",
  productName: "Agoryx",
  directories: {
    output: "release",
    buildResources: "build",
  },
  files: ["dist/**/*", "static/**/*", "package.json"],
  extraResources: [
    { from: join(root, "dist"), to: "agoryx/dist", filter: ["**/*", "!**/*.map"] },
    { from: join(root, "bin"), to: "agoryx/bin" },
    { from: join(root, "ui", "dist"), to: "agoryx/ui/dist" },
    { from: join(root, "package.json"), to: "agoryx/package.json" },
    // Written by scripts/stage-core.mjs (`npm run stage`): the root's production dependencies only.
    { from: join(__dirname, ".stage", "node_modules"), to: "agoryx/node_modules", filter: ["**/*"] },
  ],
  // The shell has no native modules of its own; the core's are not Electron's to rebuild.
  npmRebuild: false,
  mac: {
    target: [
      { target: "dir", arch: ["arm64"] },
      { target: "dmg", arch: ["arm64"] },
    ],
    category: "public.app-category.developer-tools",
    icon: "build/icon.icns",
    // A local build: no signing identity (macOS asks once on first open: right-click → Open).
    identity: null,
  },
  dmg: {
    title: "Agoryx",
  },
};
