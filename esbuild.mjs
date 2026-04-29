// esbuild.mjs — build script for orz-slides extension
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

// ── Extension host bundle (CommonJS, Node.js) ─────────────────────────────
const extensionCtx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'out/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    minify: false,
});

// ── Webview bundle (ESM IIFE, browser) ───────────────────────────────────
const webviewCtx = await esbuild.context({
    entryPoints: ['src/webview/panel.ts'],
    bundle: true,
    outfile: 'out/webview/panel.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    sourcemap: true,
    minify: false,
});

if (watch) {
    await extensionCtx.watch();
    await webviewCtx.watch();
    console.log('Watching for changes...');
} else {
    await extensionCtx.rebuild();
    await webviewCtx.rebuild();
    await extensionCtx.dispose();
    await webviewCtx.dispose();
    console.log('Build complete.');
}
