import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');
const iconsSrcDir = path.join(__dirname, 'icons');
const iconsDistDir = path.join(distDir, 'icons');

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });
fs.mkdirSync(iconsDistDir, { recursive: true });

const entries = [
  { in: 'src/content/pageBridge.ts', out: 'pageBridge.js' },
  { in: 'src/content/contentScript.ts', out: 'contentScript.js' },
  { in: 'src/background/serviceWorker.ts', out: 'serviceWorker.js' },
  { in: 'src/popup/popup.ts', out: 'popup.js' },
];

for (const entry of entries) {
  await esbuild.build({
    entryPoints: [path.join(__dirname, entry.in)],
    outfile: path.join(distDir, entry.out),
    bundle: true,
    format: 'iife',
    target: 'chrome114',
    platform: 'browser',
    sourcemap: false,
    minify: false,
  });
}

// Copy static assets to dist/
const staticFiles = [
  { src: 'manifest.json', dest: 'manifest.json' },
  { src: 'src/content/playerOverlay.css', dest: 'playerOverlay.css' },
  { src: 'src/popup/popup.html', dest: 'popup.html' },
  { src: 'src/popup/popup.css', dest: 'popup.css' },
];

for (const asset of staticFiles) {
  fs.copyFileSync(
    path.join(__dirname, asset.src),
    path.join(distDir, asset.dest)
  );
}

// Copy icons
if (fs.existsSync(iconsSrcDir)) {
  const iconFiles = fs.readdirSync(iconsSrcDir);
  for (const file of iconFiles) {
    fs.copyFileSync(
      path.join(iconsSrcDir, file),
      path.join(iconsDistDir, file)
    );
  }
}

console.log('✅ Built Edge/Chrome Extension (Manifest V3) into extension/dist/');
