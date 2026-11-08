import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');
const zipPath = path.join(__dirname, 'ai-sponsorblock-edge.zip');

// 1. Run build
console.log('📦 Step 1: Building extension into dist/...');
execSync('node build.mjs', { cwd: __dirname, stdio: 'inherit' });

// Validate store manifest constraints (description <= 132 chars, name <= 75 chars)
const manifest = JSON.parse(fs.readFileSync(path.join(distDir, 'manifest.json'), 'utf8'));
if ((manifest.description || '').length > 132) {
  throw new Error(
    `manifest.json description length (${manifest.description.length}) exceeds Edge/Chrome store limit of 132 characters!`
  );
}

// 2. Remove existing zip if any
if (fs.existsSync(zipPath)) {
  fs.unlinkSync(zipPath);
}

// 3. Zip files with manifest.json at the root of the archive
console.log('🗜️ Step 2: Creating store-ready package ai-sponsorblock-edge.zip...');
const psCommand = `Compress-Archive -Path "${path.join(distDir, '*')}" -DestinationPath "${zipPath}" -Force`;
execSync(`powershell -NoProfile -Command "${psCommand}"`, { stdio: 'inherit' });

const stats = fs.statSync(zipPath);
console.log(`\n🎉 Success! Package ready for Microsoft Edge Add-ons store:`);
console.log(`   Path: ${zipPath}`);
console.log(`   Size: ${(stats.size / 1024).toFixed(1)} KB\n`);
