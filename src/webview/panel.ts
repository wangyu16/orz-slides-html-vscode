/**
 * panel.ts — Webview entry point for orz-slides editor
 * Compiled to out/webview/panel.js by esbuild (IIFE, browser target).
 *
 * Renders: toolbar + thumbnail strip + CodeMirror editor + preview iframe
 */

import { SlidesFile, DeckSettings, ExtMessage, PanelMessage, InitMessage } from '../types';

// ─── VS Code Webview API ──────────────────────────────────────────────────────
declare function acquireVsCodeApi(): {
    postMessage(msg: PanelMessage): void;
    getState(): unknown;
    setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

// Nonce injected by the extension host — used in srcdoc inline scripts so they
// pass the parent webview's CSP (which requires 'nonce-XXX' on all scripts).
const CSP_NONCE: string = (window as unknown as Record<string, string>).__CSP_NONCE__ || '';

// ─── State ────────────────────────────────────────────────────────────────────

let slidesFile: SlidesFile | undefined;
let currentIndex = 0;
let editorContent = '';
let saveDebounceTimer: ReturnType<typeof setTimeout> | undefined;
let renderDebounceTimer: ReturnType<typeof setTimeout> | undefined;

// Inline CSS passed from extension host — used in srcdoc preview
let baseStylesCss = '';
let themeCss = '';
let previewBaseHref = '';
let showFrames = true;   // toggled by toolbar button

// Preview iframe smart-update state
// - 'uninitialized': no srcdoc has been set yet
// - 'loading':  srcdoc was set, waiting for Reveal 'ready' inside iframe
// - 'ready':    iframe is initialized, in-place postMessage updates are safe
let previewLoadState: 'uninitialized' | 'loading' | 'ready' = 'uninitialized';
let previewLoadSeq = 0;          // incremented on every new srcdoc assignment
let previewPendingHtml: string | undefined;   // HTML queued while loading
let lastPreviewKey = '';         // theme|ratio|cssHash — detects when full rebuild is needed

// ─── DOM setup ────────────────────────────────────────────────────────────────

const app = document.getElementById('app')!;
const loading = document.getElementById('loading')!;

// ─── Main UI Builder ──────────────────────────────────────────────────────────

function buildUI(file: SlidesFile): void {
    loading.style.display = 'none';
    app.innerHTML = '';

    // Reset preview state — the old iframe is gone, we'll build a fresh one
    previewLoadState = 'uninitialized';
    previewPendingHtml = undefined;
    lastPreviewKey = '';

    const root = document.createElement('div');
    root.id = 'slides-root';
    root.style.cssText = 'display:flex;flex-direction:column;height:100%;overflow:hidden;';

    // Toolbar
    root.appendChild(buildToolbar(file.settings));

    // Body row: thumbnails + editor + resize handle + preview
    const body = document.createElement('div');
    body.id = 'slides-body';
    body.style.cssText = 'display:flex;flex:1 1 0;overflow:hidden;min-height:0;';

    const thumbs  = buildThumbnailStrip(file);
    const editor  = buildEditor();
    const handle  = buildResizeHandle();
    const preview = buildPreview();

    body.appendChild(thumbs);
    body.appendChild(editor);
    body.appendChild(handle);
    body.appendChild(preview);

    root.appendChild(body);
    app.appendChild(root);

    wireResizeHandle(handle, editor, preview);
    initCodeMirror(editor.querySelector('#cm-host')!);
    selectSlide(currentIndex);   // currentIndex was set by the init handler
}

// ─── Toolbar ──────────────────────────────────────────────────────────────────

function buildToolbar(settings: DeckSettings): HTMLElement {
    const bar = document.createElement('div');
    bar.id = 'toolbar';
    bar.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 8px;background:var(--vscode-titleBar-activeBackground,#1e1e2e);border-bottom:1px solid var(--vscode-editorGroup-border,#333);flex-shrink:0;flex-wrap:wrap;';

    // Nav buttons
    bar.appendChild(btn('◀', 'prev', 'Previous slide', () => navigate(-1)));
    const slideLabel = document.createElement('span');
    slideLabel.id = 'slide-label';
    slideLabel.style.cssText = 'font-size:12px;color:var(--vscode-foreground);min-width:50px;text-align:center;';
    slideLabel.textContent = '1 / 1';
    bar.appendChild(slideLabel);
    bar.appendChild(btn('▶', 'next', 'Next slide', () => navigate(1)));

    bar.appendChild(sep());

    // Add/delete slide
    bar.appendChild(btn('＋', 'add-slide', 'Add slide after current', () => addSlide()));
    bar.appendChild(btn('✕', 'del-slide', 'Delete current slide', () => deleteSlide()));

    bar.appendChild(sep());

    // Theme selector
    const themeLabel = label('Theme:');
    const themeSelect = document.createElement('select');
    themeSelect.id = 'theme-select';
    themeSelect.style.cssText = selectStyle();
    const themes = ['executive', 'paper', 'sage', 'architect', 'poppy', 'neon', 'chalk'];
    for (const t of themes) {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t.charAt(0).toUpperCase() + t.slice(1);
        if (t === settings.theme) { opt.selected = true; }
        themeSelect.appendChild(opt);
    }
    themeSelect.addEventListener('change', () => {
        if (!slidesFile) { return; }
        const newSettings: DeckSettings = { ...slidesFile.settings, theme: themeSelect.value };
        slidesFile.settings = newSettings;
        updatePreviewTheme(newSettings.theme);
        post({ type: 'settingsChanged', settings: newSettings });
    });
    bar.appendChild(themeLabel);
    bar.appendChild(themeSelect);

    bar.appendChild(sep());

    // Aspect ratio selector
    const ratioLabel = label('Ratio:');
    const ratioSelect = document.createElement('select');
    ratioSelect.id = 'ratio-select';
    ratioSelect.style.cssText = selectStyle();
    const ratios: DeckSettings['aspectRatio'][] = ['16:9', '4:3', '16:10', '1:1'];
    for (const r of ratios) {
        const opt = document.createElement('option');
        opt.value = r;
        opt.textContent = r;
        if (r === settings.aspectRatio) { opt.selected = true; }
        ratioSelect.appendChild(opt);
    }
    ratioSelect.addEventListener('change', () => {
        if (!slidesFile) { return; }
        const newSettings: DeckSettings = {
            ...slidesFile.settings,
            aspectRatio: ratioSelect.value as DeckSettings['aspectRatio'],
        };
        slidesFile.settings = newSettings;
        post({ type: 'settingsChanged', settings: newSettings });
        reloadPreview();
    });
    bar.appendChild(ratioLabel);
    bar.appendChild(ratioSelect);

    bar.appendChild(sep());

    // Frames toggle
    const framesBtn = document.createElement('button');
    framesBtn.id = 'frames-btn';
    framesBtn.title = 'Show/hide layout container frames';
    framesBtn.style.cssText = 'background:var(--vscode-button-secondaryBackground,#3a3a4a);color:var(--vscode-button-secondaryForeground,#ccc);border:1px solid var(--vscode-button-border,transparent);padding:3px 8px;cursor:pointer;border-radius:3px;font-size:11px;';
    const updateFramesBtn = () => {
        framesBtn.textContent = showFrames ? '⬜ Frames' : '▪ Frames';
        framesBtn.style.opacity = showFrames ? '1' : '0.55';
    };
    updateFramesBtn();
    framesBtn.addEventListener('click', () => {
        showFrames = !showFrames;
        updateFramesBtn();
        // Prefer a direct DOM class toggle to avoid a full srcdoc rebuild
        const frame = document.getElementById('preview-frame') as HTMLIFrameElement | null;
        if (frame && previewLoadState === 'ready') {
            try {
                frame.contentDocument?.body.classList.toggle('orz-show-frames', showFrames);
                return;
            } catch { /* fall through to full rebuild */ }
        }
        updatePreviewIframe(true);
    });
    bar.appendChild(framesBtn);

    return bar;
}

// ─── Thumbnail strip ──────────────────────────────────────────────────────────

function buildThumbnailStrip(file: SlidesFile): HTMLElement {
    const strip = document.createElement('div');
    strip.id = 'thumb-strip';
    strip.style.cssText = 'width:120px;flex-shrink:0;overflow-y:auto;background:var(--vscode-sideBar-background,#252526);border-right:1px solid var(--vscode-editorGroup-border,#333);display:flex;flex-direction:column;gap:2px;padding:4px;';
    rebuildThumbs(strip, file);
    return strip;
}

function rebuildThumbs(strip: HTMLElement, file: SlidesFile): void {
    strip.innerHTML = '';
    for (let i = 0; i < file.slides.length; i++) {
        const s = file.slides[i];
        const thumb = document.createElement('div');
        thumb.className = 'slide-thumb' + (i === currentIndex ? ' active' : '');
        thumb.dataset.index = String(i);
        thumb.style.cssText = thumbStyle(i === currentIndex);

        // Slide number
        const num = document.createElement('div');
        num.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:2px;';
        num.textContent = `${i + 1}`;

        // Title (first h1/h2 in source)
        const title = document.createElement('div');
        title.style.cssText = 'font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;';
        title.textContent = extractSlideTitle(s.source);

        thumb.appendChild(num);
        thumb.appendChild(title);

        thumb.addEventListener('click', () => selectSlide(i));
        strip.appendChild(thumb);
    }
}

function thumbStyle(active: boolean): string {
    const base = 'padding:4px 6px;cursor:pointer;border-radius:3px;border:1px solid transparent;';
    return active
        ? base + 'background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground);border-color:var(--vscode-focusBorder);'
        : base + 'background:transparent;color:var(--vscode-foreground);';
}

function extractSlideTitle(source: string): string {
    const m = /^#{1,2}\s+(.+)$/m.exec(source);
    return m ? m[1].trim().slice(0, 30) : '—';
}

// ─── Editor pane ──────────────────────────────────────────────────────────────

function buildEditor(): HTMLElement {
    const pane = document.createElement('div');
    pane.id = 'editor-pane';
    pane.style.cssText = 'flex:1 1 0;min-width:0;display:flex;flex-direction:column;overflow:hidden;';

    const host = document.createElement('div');
    host.id = 'cm-host';
    host.style.cssText = 'flex:1 1 0;overflow:auto;font-size:13px;';
    pane.appendChild(host);
    return pane;
}

// ─── CodeMirror setup ─────────────────────────────────────────────────────────
// We use a minimal in-browser setup with a <textarea> fallback since CodeMirror
// 6 requires npm bundling. The panel.ts is compiled by esbuild so we import from
// the npm packages listed in devDependencies.

// NOTE: CodeMirror 6 packages are bundled. If not installed, textarea fallback is used.
let cmEditor: { dispatch: (tr: unknown) => void; state: { doc: { toString(): string } } } | undefined;

function initCodeMirror(host: HTMLElement): void {
    // Try to import CodeMirror dynamically — esbuild will bundle it if available.
    // For now, use a simple textarea as the initial scaffold (Phase 2 Polish will
    // swap in the full CodeMirror editor).
    const textarea = document.createElement('textarea');
    textarea.id = 'cm-textarea';
    textarea.style.cssText = 'width:100%;height:100%;box-sizing:border-box;padding:10px 14px;font-family:var(--vscode-editor-font-family,monospace);font-size:13px;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);border:none;resize:none;outline:none;tab-size:2;';
    textarea.value = editorContent;
    textarea.spellcheck = false;

    textarea.addEventListener('input', () => {
        editorContent = textarea.value;
        // Keep in-memory slide source in sync so navigation away-and-back shows current content
        if (slidesFile) {
            const slide = slidesFile.slides.find(s => s.index === currentIndex);
            if (slide) { slide.source = editorContent; }
        }
        scheduleRender();
        scheduleSave();
    });

    host.appendChild(textarea);
}

function setEditorContent(source: string): void {
    editorContent = source;
    const ta = document.getElementById('cm-textarea') as HTMLTextAreaElement | null;
    if (ta) { ta.value = source; }
}

// ─── Preview iframe ───────────────────────────────────────────────────────────

function buildPreview(): HTMLElement {
    const pane = document.createElement('div');
    pane.id = 'preview-pane';
    pane.style.cssText = 'flex:1 1 0;min-width:0;display:flex;flex-direction:column;overflow:hidden;background:#111;';

    const frame = document.createElement('iframe');
    frame.id = 'preview-frame';
    frame.style.cssText = 'flex:1;width:100%;border:none;background:#fff;';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    pane.appendChild(frame);
    return pane;
}

/** Key that identifies the current srcdoc configuration.
 *  A key change means we must do a full srcdoc rebuild. */
function previewKey(): string {
    if (!slidesFile) { return ''; }
    return `${slidesFile.settings.theme}|${slidesFile.settings.aspectRatio}|${themeCss.slice(0, 64)}`;
}

/**
 * Update the preview iframe.
 * - If the iframe is uninitialised or settings changed → full srcdoc rebuild.
 * - If already ready → post an in-place updateSlide message (no flash, no reload).
 * - If currently loading → queue the HTML; apply it after the ready signal arrives.
 */
function updatePreviewIframe(forceRebuild = false): void {
    if (!slidesFile) { return; }
    const frame = document.getElementById('preview-frame') as HTMLIFrameElement | null;
    if (!frame) { return; }
    const slide = slidesFile.slides[currentIndex];
    if (!slide) { return; }

    const key = previewKey();
    const needsRebuild = forceRebuild || previewLoadState === 'uninitialized' || key !== lastPreviewKey;

    if (previewLoadState === 'loading') {
        // Don't interrupt an in-flight load — just queue content and flag if rebuild needed
        previewPendingHtml = slide.sectionHtml;
        if (key !== lastPreviewKey) {
            lastPreviewKey = '';  // force rebuild when current load finishes
        }
        return;
    }

    if (needsRebuild) {
        lastPreviewKey = key;
        previewLoadState = 'loading';
        previewPendingHtml = undefined;
        const seq = ++previewLoadSeq;
        frame.srcdoc = buildSlideSrcdoc(slide.sectionHtml, slidesFile.settings, seq);
    } else {
        // iframe is ready — update content in-place, no flash
        sendSlideUpdate(frame, slide.sectionHtml);
    }
}

function sendSlideUpdate(frame: HTMLIFrameElement, html: string): void {
    frame.contentWindow?.postMessage(
        { _from: 'orz-slides-parent', type: 'updateSlide', html },
        '*'
    );
}

function handlePreviewReady(seq: number): void {
    if (seq !== previewLoadSeq) { return; }  // stale signal from a superseded load
    previewLoadState = 'ready';

    const frame = document.getElementById('preview-frame') as HTMLIFrameElement | null;
    if (!frame) { return; }

    if (previewPendingHtml !== undefined) {
        // Content changed while loading — apply queued HTML now
        sendSlideUpdate(frame, previewPendingHtml);
        previewPendingHtml = undefined;
    } else if (slidesFile) {
        // Settings may have changed while loading — check for rebuild
        const key = previewKey();
        if (key !== lastPreviewKey) {
            updatePreviewIframe(true);
        }
    }
}

function buildResizeHandle(): HTMLElement {
    const handle = document.createElement('div');
    handle.id = 'resize-handle';
    handle.style.cssText = 'width:4px;cursor:col-resize;background:var(--vscode-editorGroup-border,#333);flex-shrink:0;';
    handle.title = 'Drag to resize';
    return handle;
}

function wireResizeHandle(handle: HTMLElement, editorPane: HTMLElement, previewPane: HTMLElement): void {
    let dragging = false;
    let startX = 0;
    let startEditorW = 0;
    let startPreviewW = 0;

    // Use pointer capture so pointerup is always received, even when the cursor
    // leaves the webview iframe (the classic "drag gets stuck" problem).
    handle.addEventListener('pointerdown', (e) => {
        dragging = true;
        startX = e.clientX;
        startEditorW = editorPane.getBoundingClientRect().width;
        startPreviewW = previewPane.getBoundingClientRect().width;
        handle.setPointerCapture(e.pointerId);
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });

    handle.addEventListener('pointermove', (e) => {
        if (!dragging) { return; }
        const dx = e.clientX - startX;
        const newEditorW = Math.max(150, startEditorW + dx);
        const newPreviewW = Math.max(150, startPreviewW - dx);
        editorPane.style.flex = `0 0 ${newEditorW}px`;
        previewPane.style.flex = `0 0 ${newPreviewW}px`;
    });

    handle.addEventListener('pointerup', () => {
        if (!dragging) { return; }
        dragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });

    handle.addEventListener('pointercancel', () => {
        dragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });
}

// ─── Slide selection ──────────────────────────────────────────────────────────

function selectSlide(index: number): void {
    if (!slidesFile) { return; }
    if (index < 0 || index >= slidesFile.slides.length) { return; }

    // Flush any pending edit for the slide we're leaving
    if (index !== currentIndex && slidesFile) {
        const leaving = slidesFile.slides.find(s => s.index === currentIndex);
        if (leaving && leaving.source !== editorContent) {
            // Update in-memory source so returning to this slide shows the edited content
            leaving.source = editorContent;
            // Cancel pending debounces and save immediately so the file stays in sync
            if (saveDebounceTimer)   { clearTimeout(saveDebounceTimer);   saveDebounceTimer = undefined; }
            if (renderDebounceTimer) { clearTimeout(renderDebounceTimer); renderDebounceTimer = undefined; }
            post({ type: 'saveFile', index: currentIndex, source: editorContent });
        }
    }

    currentIndex = index;
    const slide = slidesFile.slides[index];

    // Update editor
    setEditorContent(slide.source);

    // Update thumbnail highlight
    const strip = document.getElementById('thumb-strip');
    if (strip) {
        strip.querySelectorAll('.slide-thumb').forEach((el, i) => {
            (el as HTMLElement).style.cssText = thumbStyle(i === index);
            el.className = 'slide-thumb' + (i === index ? ' active' : '');
        });
    }

    // Update slide counter
    const label = document.getElementById('slide-label');
    if (label) { label.textContent = `${index + 1} / ${slidesFile.slides.length}`; }

    // Update preview iframe to show this slide
    updatePreviewIframe();

    post({ type: 'navigateTo', index });
}

function buildSlideSrcdoc(sectionHtml: string, settings: DeckSettings, loadSeq: number = 0): string {
    const [rw, rh] = settings.aspectRatio.split(':').map(Number);
    const w = 1600;
    const h = Math.round(w * rh / rw);
    const darkThemes = ['neon', 'chalk'];
    const hljsTheme = darkThemes.includes(settings.theme) ? 'atom-one-dark.min.css' : 'github.min.css';
    const hljsBase = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/';
    const baseHref = previewBaseHref
        ? (previewBaseHref.endsWith('/') ? previewBaseHref : `${previewBaseHref}/`)
        : '';
    const baseTag = baseHref
        ? `<base href="${baseHref.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`
        : '';

    // Resolve relative local paths (images, etc.) to absolute vscode-resource URLs
    // so they load correctly inside the srcdoc iframe.
    const resolvedHtml = resolveLocalPaths(sectionHtml, baseHref);

    // Frames: add class to body so the .orz-show-frames CSS rules fire
    const bodyClass = showFrames ? ' class="orz-show-frames"' : '';

    // Theme CSS may define vars on :root, .reveal, or both.
    // Re-wrap on :root so they are reachable from all nested elements.
    const themeBlock = themeCss
        ? `<style id="theme-styles">${themeCss}</style>\n<style id="theme-vars">:root{${extractCssVars(themeCss)}}</style>`
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${baseTag}
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/reveal.js/5.0.4/reset.min.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/reveal.js/5.0.4/reveal.min.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/reveal.js/5.0.4/theme/simple.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<link rel="stylesheet" href="${hljsBase}${hljsTheme}">
<style id="base-styles">${baseStylesCss}</style>
${themeBlock}
<style>
html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
.reveal .slides section { padding: 0 !important; width: 100%; height: 100%; }
/* Guaranteed orz-body-center (in case base-styles is from an older file) */
.orz-body.orz-body-center { display:flex; flex-direction:column; align-items:center; justify-content:center; }
.reveal section img,
.reveal section [data-smiles],
.reveal .mermaid,
.reveal .youtube-embed {
    display:block;
    margin-left:auto;
    margin-right:auto;
    max-width:100%;
}
.reveal section img {
    width:auto;
    height:auto;
    max-height:100%;
    object-fit:contain;
}
.reveal section svg[data-smiles],
.reveal section canvas[data-smiles],
.reveal section img[data-smiles] {
    width:auto;
    max-width:300px;
    height:auto;
}
.reveal .smiles-render { display:flex; justify-content:center; }
.reveal .mermaid,
.reveal .youtube-embed {
    width:100%;
}
.reveal .mermaid svg {
    display:block;
    margin-left:auto;
    margin-right:auto;
    width:100% !important;
    max-width:100% !important;
    height:auto !important;
}
.reveal .youtube-embed {
    aspect-ratio:16 / 9;
}
.reveal .youtube-embed iframe {
    display:block;
    width:100%;
    height:100%;
    border:0;
}
/* QR code: doubled default size + pointer cursor for click-to-fullscreen */
.reveal span.qrcode {
        display:inline-block;
        background:#fff;
        padding:4px;
        cursor:pointer;
        position:relative;
        line-height:0;
        overflow:hidden;
        vertical-align:middle;
}
.reveal span.qrcode::after {
    content:'⤢'; position:absolute; top:6px; right:6px; z-index:1;
  font-size:11px; line-height:1; color:#333; background:rgba(255,255,255,0.88);
  border-radius:2px; padding:1px 3px; pointer-events:none; opacity:0.75;
}
.reveal span.qrcode:hover::after { opacity:1; }
.reveal span.qrcode svg, .reveal span.qrcode canvas, .reveal span.qrcode img {
    display:block; width:160px !important; height:160px !important; max-width:none;
}
/* Fullscreen QR overlay */
#qr-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.85);
  z-index:9999; align-items:center; justify-content:center; cursor:pointer; }
#qr-overlay.visible { display:flex; }
#qr-overlay svg { width:min(80vw,80vh); height:min(80vw,80vh); background:#fff; padding:12px; border-radius:4px; }
/* Inline code — override Reveal theme CSS with theme variables */
.reveal :not(pre) > code {
  background: var(--inline-code-bg, #f5f5f5);
  border-color: var(--inline-code-border, #ddd);
  color: var(--inline-code-color, inherit);
}
</style>
</head>
<body${bodyClass}>
<div id="qr-overlay" onclick="this.classList.remove('visible')"></div>
<div class="reveal">
  <div class="slides">
    <section>${resolvedHtml}</section>
  </div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/reveal.js/5.0.4/reveal.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/reveal.js/5.0.4/plugin/notes/notes.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/reveal.js/5.0.4/plugin/highlight/highlight.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script src="https://unpkg.com/smiles-drawer@1.0.10/dist/smiles-drawer.min.js"></script>
<script nonce="${CSP_NONCE}">
Reveal.initialize({
  center: false, hash: false, slideNumber: false,
  width: ${w}, height: ${h}, margin: 0.04,
  minScale: 0.1, maxScale: 2.0,
  plugins: [RevealHighlight, RevealNotes]
});

function fitMermaid(container) {
    (container || document).querySelectorAll('.mermaid svg').forEach(function(svg) {
        svg.style.display = 'block';
        svg.style.marginLeft = 'auto';
        svg.style.marginRight = 'auto';
        svg.style.width = '100%';
        svg.style.maxWidth = '100%';
        svg.style.height = 'auto';
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    });
}

function resetFragments(section) {
    section.querySelectorAll('.fragment').forEach(function(fragment) {
        fragment.classList.remove('visible', 'current-fragment');
    });
    if (typeof Reveal.slide === 'function') {
        Reveal.slide(0, 0, -1);
    }
}

function slugTabKey(label, index) {
    var base = String(label || ('tab-' + (index + 1))).toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return base || ('tab-' + (index + 1));
}

function getTabPanels(tabsEl) {
    var directTabs = Array.from(tabsEl.children).filter(function(child) {
        return child.classList && child.classList.contains('tab');
    });
    if (directTabs.length) {
        return directTabs;
    }
    return Array.from(tabsEl.children).flatMap(function(child) {
        if (!child.classList || !child.classList.contains('markdown-body')) {
            return [];
        }
        return Array.from(child.children).filter(function(grandChild) {
            return grandChild.classList && grandChild.classList.contains('tab');
        });
    });
}

function activateTab(tabsEl, key) {
    var panels = getTabPanels(tabsEl);
    var buttons = Array.from(tabsEl.querySelectorAll(':scope > .tabs-bar .tabs-bar-btn'));
    if (!panels.length || !buttons.length) return;

    var targetKey = key;
    var hasMatch = panels.some(function(panel) {
        return panel.getAttribute('data-tab-key') === targetKey;
    });
    if (!hasMatch) {
        targetKey = panels[0].getAttribute('data-tab-key') || '';
    }

    buttons.forEach(function(button) {
        button.classList.toggle('active', button.getAttribute('data-tab-key') === targetKey);
    });
    panels.forEach(function(panel) {
        panel.classList.toggle('active', panel.getAttribute('data-tab-key') === targetKey);
    });
}

function initTabs(container) {
    (container || document).querySelectorAll('.tabs').forEach(function(tabsEl) {
        var tabs = getTabPanels(tabsEl);
        if (!tabs.length) return;

        var bar = tabsEl.querySelector(':scope > .tabs-bar');
        if (!bar) {
            bar = document.createElement('div');
            bar.className = 'tabs-bar';
            tabsEl.insertBefore(bar, tabsEl.firstChild);
        }

        var existingButtons = Array.from(bar.querySelectorAll(':scope > .tabs-bar-btn'));
        var shouldRebuildButtons = existingButtons.length !== tabs.length;

        tabs.forEach(function(tab, i) {
            var label = tab.getAttribute('data-label') || ('Tab ' + (i + 1));
            var existingKey = tab.getAttribute('data-tab-key') || (tab.id || '').replace(/^tab-/, '');
            var key = existingKey || slugTabKey(label, i);
            tab.setAttribute('data-tab-key', key);
            if (!tab.id) {
                tab.id = 'tab-' + key;
            }
        });

        if (shouldRebuildButtons) {
            bar.innerHTML = '';
            tabs.forEach(function(tab, i) {
                var button = document.createElement('button');
                button.type = 'button';
                button.className = 'tabs-bar-btn';
                button.textContent = tab.getAttribute('data-label') || ('Tab ' + (i + 1));
                button.setAttribute('data-tab-key', tab.getAttribute('data-tab-key') || '');
                bar.appendChild(button);
            });
            existingButtons = Array.from(bar.querySelectorAll(':scope > .tabs-bar-btn'));
        } else {
            existingButtons.forEach(function(button, i) {
                var tab = tabs[i];
                button.type = 'button';
                button.setAttribute('data-tab-key', tab.getAttribute('data-tab-key') || '');
                if (!button.textContent || !button.textContent.trim()) {
                    button.textContent = tab.getAttribute('data-label') || ('Tab ' + (i + 1));
                }
            });
        }

        tabsEl.setAttribute('data-js', '1');
        var activeTab = tabs.find(function(tab) { return tab.classList.contains('active'); }) || tabs[0];
        activateTab(tabsEl, activeTab.getAttribute('data-tab-key') || '');
    });
}

document.addEventListener('click', function(e) {
    var btn = e.target.closest && e.target.closest('.tabs-bar-btn');
    if (!btn) return;
    var tabs = btn.closest('.tabs');
    if (!tabs) return;
    var key = btn.getAttribute('data-tab-key') || '';
    if (!key) {
        var m = (btn.getAttribute('onclick') || '').match(/switchTab\\s*\\(this\\s*,\\s*['"]([^'"]+)['"]\\)/);
        key = m ? m[1] : '';
    }
    activateTab(tabs, key);
});
Reveal.on('ready', function() { initTabs(document); });
Reveal.on('slidechanged', function(e) { initTabs(e.currentSlide); });

// QR code click to fullscreen
document.addEventListener('click', function(e) {
    var qr = e.target.closest('span.qrcode');
  if (!qr) return;
  var overlay = document.getElementById('qr-overlay');
  if (!overlay) return;
    var graphic = qr.querySelector('svg, canvas, img');
    if (!graphic) return;
    overlay.innerHTML = '';
    overlay.appendChild(graphic.cloneNode(true));
    var clone = overlay.firstElementChild;
    if (clone) {
        clone.style.width = 'min(80vw,80vh)';
        clone.style.height = 'min(80vw,80vh)';
        clone.style.background = '#fff';
        clone.style.padding = '12px';
        clone.style.borderRadius = '4px';
        clone.style.display = 'block';
    }
  overlay.classList.add('visible');
  overlay.onclick = function() { overlay.classList.remove('visible'); };
});

// SmilesDrawer
var _smilesOpts = {
  bondThickness: 0.9, fontSizeLarge: 11, fontSizeSmall: 3, padding: 16, terminalCarbons: true,
  themes: {
    light: { C:'#222', O:'#c0392b', N:'#2980b9', F:'#27ae60', CL:'#16a085', BR:'#d35400', I:'#8e44ad', S:'#f39c12', P:'#27ae60', H:'#666' },
    dark:  { C:'#eee', O:'#e74c3c', N:'#3498db', F:'#2ecc71', CL:'#1abc9c', BR:'#e67e22', I:'#9b59b6', S:'#f1c40f', P:'#2ecc71', H:'#aaa' }
  }
};
function _smilesIsDark(el) {
  var node = el;
  while (node && node !== document.documentElement) {
    var bg = window.getComputedStyle(node).backgroundColor;
    var m = bg.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/i);
    if (m && bg !== 'rgba(0, 0, 0, 0)') { return (0.2126*m[1]+0.7152*m[2]+0.0722*m[3])/255 < 0.45; }
    node = node.parentElement;
  }
  return false;
}
function renderSmiles(container) {
    if (typeof SmilesDrawer === 'undefined' || !SmilesDrawer.Drawer || !SmilesDrawer.parse) return;
    Array.prototype.slice.call((container || document).querySelectorAll('canvas[data-smiles]')).forEach(function(canvas, i) {
        var smiles = canvas.getAttribute('data-smiles');
        if (!smiles) return;
        var freshCanvas = canvas.cloneNode(false);
        freshCanvas.width = canvas.width || parseInt(canvas.getAttribute('width')) || 220;
        freshCanvas.height = canvas.height || parseInt(canvas.getAttribute('height')) || 220;
        if (canvas.id) {
            freshCanvas.id = canvas.id;
        } else {
            freshCanvas.id = 'smiles-canvas-' + i;
        }
        freshCanvas.setAttribute('data-smiles', smiles);
        var theme = canvas.getAttribute('data-smiles-theme') || (_smilesIsDark(canvas) ? 'dark' : 'light');
        if (canvas.getAttribute('data-smiles-theme')) {
            freshCanvas.setAttribute('data-smiles-theme', canvas.getAttribute('data-smiles-theme'));
        }
        canvas.replaceWith(freshCanvas);
        var drawer = new SmilesDrawer.Drawer({ width: freshCanvas.width, height: freshCanvas.height });
        SmilesDrawer.parse(smiles, function(tree) {
            if (!freshCanvas.isConnected) return;
            drawer.draw(tree, freshCanvas, theme, false);
            freshCanvas.setAttribute('data-smiles-done', theme);
        }, function(err) {
            console.warn('SMILES:', err);
        });
    });
}

Reveal.on('ready', function() {
  if (window.renderMathInElement) {
    renderMathInElement(document.body, {
      delimiters: [{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}],
      ignoredTags: ['script','noscript','style','textarea','pre','code'],
      throwOnError: false
    });
  }
  if (window.mermaid) {
    mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose',
      flowchart: { useMaxWidth: true, htmlLabels: true }, sequence: { useMaxWidth: true } });
        Promise.resolve(mermaid.run()).then(function() { fitMermaid(Reveal.getCurrentSlide()); });
  }
  if (window.hljs) { hljs.highlightAll(); }
  renderSmiles(Reveal.getCurrentSlide());
  // Signal to the parent webview that the preview is ready for in-place updates
  window.parent.postMessage({ _from: 'orz-slides-preview', type: 'previewReady', seq: ${loadSeq} }, '*');
});
Reveal.on('slidechanged', function(e) { renderSmiles(e.currentSlide); });
if (typeof window.SmilesDrawer === 'undefined') {
    var _smilesRetry = 0;
    (function waitForSmiles() {
        if (typeof window.SmilesDrawer !== 'undefined') {
            renderSmiles(Reveal.getCurrentSlide());
            return;
        }
        if (_smilesRetry++ < 40) { setTimeout(waitForSmiles, 100); }
    })();
}

// ─── In-place update listener ────────────────────────────────────────────────
// Receives 'updateSlide' messages from the parent webview and updates the
// current section's innerHTML without reloading the whole iframe.
window.addEventListener('message', function(e) {
    if (!e.data || e.data._from !== 'orz-slides-parent' || e.data.type !== 'updateSlide') { return; }
    var section = document.querySelector('.reveal .slides section');
    if (!section) { return; }
    section.innerHTML = e.data.html;
    Reveal.sync();
    resetFragments(section);
    if (window.hljs) {
        section.querySelectorAll('pre code').forEach(function(el) {
            el.removeAttribute('data-highlighted');
            hljs.highlightElement(el);
        });
    }
    if (window.renderMathInElement) {
        renderMathInElement(section, {
            delimiters: [{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}],
            ignoredTags: ['script','noscript','style','textarea','pre','code'],
            throwOnError: false
        });
    }
    if (window.mermaid) {
        var merms = section.querySelectorAll('.mermaid:not([data-processed])');
        if (merms.length) {
            Promise.resolve(mermaid.run({ nodes: merms })).then(function() { fitMermaid(section); });
        } else {
            fitMermaid(section);
        }
    }
    renderSmiles(section);
    if (typeof initTabs === 'function') { initTabs(section); }
});
</script>
</body>
</html>`;
}

/**
 * Rewrite relative src/href attributes in HTML to absolute URLs using the given
 * base so that local images load correctly inside the srcdoc iframe.
 * Absolute URLs (http/https/data/blob) and anchors (#) are left untouched.
 */
function resolveLocalPaths(html: string, base: string): string {
    if (!base) { return html; }
    return html.replace(/\b(src|href)="([^"]+)"/gi, (match, attr: string, val: string) => {
        // Leave absolute URLs, data URIs, blobs, javascript, mailto, and anchors alone
        if (/^(https?|ftp|data|blob|javascript|mailto):|^#|^vscode/.test(val)) { return match; }
        try {
            return `${attr}="${new URL(val, base).toString()}"`;
        } catch {
            return match;
        }
    });
}

/**
 * Extract all CSS custom-property declarations (--foo: bar) from a CSS string
 * and return them as a single flat declaration block (without the selector),
 * so they can be re-applied on :root in the srcdoc.
 */
function extractCssVars(css: string): string {
    const vars: string[] = [];
    const re = /(--[\w-]+)\s*:\s*([^;}{]+);/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css)) !== null) {
        vars.push(`${m[1]}:${m[2].trim()}`);
    }
    return vars.join(';');
}

function updatePreviewTheme(_theme: string): void {
    // Don't rebuild here — themeCss hasn't been updated yet.
    // The settingsAck handler receives the correct CSS and does a forced rebuild.
}

function reloadPreview(): void {
    updatePreviewIframe(true);
}

// ─── Debounced render + save ──────────────────────────────────────────────────

function scheduleRender(): void {
    if (renderDebounceTimer) { clearTimeout(renderDebounceTimer); }
    renderDebounceTimer = setTimeout(() => {
        post({ type: 'contentChanged', index: currentIndex, source: editorContent });
    }, 300);
}

function scheduleSave(): void {
    if (saveDebounceTimer) { clearTimeout(saveDebounceTimer); }
    saveDebounceTimer = setTimeout(() => {
        post({ type: 'saveFile', index: currentIndex, source: editorContent });
    }, 1000);
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function navigate(delta: number): void {
    if (!slidesFile) { return; }
    const next = Math.max(0, Math.min(slidesFile.slides.length - 1, currentIndex + delta));
    if (next !== currentIndex) { selectSlide(next); }
}

function addSlide(): void {
    // Cancel any pending debounced save — the extension will flush the current
    // source atomically before inserting the new slide.
    if (saveDebounceTimer) { clearTimeout(saveDebounceTimer); saveDebounceTimer = undefined; }
    if (renderDebounceTimer) { clearTimeout(renderDebounceTimer); renderDebounceTimer = undefined; }
    post({ type: 'addSlide', afterIndex: currentIndex, pendingIndex: currentIndex, pendingSource: editorContent });
}

function deleteSlide(): void {
    if (!slidesFile || slidesFile.slides.length <= 1) { return; }
    if (saveDebounceTimer) { clearTimeout(saveDebounceTimer); saveDebounceTimer = undefined; }
    if (renderDebounceTimer) { clearTimeout(renderDebounceTimer); renderDebounceTimer = undefined; }
    post({ type: 'deleteSlide', index: currentIndex, pendingIndex: currentIndex, pendingSource: editorContent });
}

// ─── Message handling ─────────────────────────────────────────────────────────

window.addEventListener('message', (event) => {
    // Messages from the preview iframe carry _from: 'orz-slides-preview'
    if (event.data?._from === 'orz-slides-preview') {
        if (event.data.type === 'previewReady') {
            handlePreviewReady(event.data.seq as number);
        }
        return;
    }
    // All other messages come from the extension host
    const msg = event.data as ExtMessage;
    handleExtMessage(msg);
});

function handleExtMessage(msg: ExtMessage): void {
    switch (msg.type) {
        case 'init': {
            slidesFile = msg.file;
            // Explicit selectIndex wins (add/delete slide operations).
            // If not specified, stay on the current slide if it still exists (external-edit reload),
            // or fall back to 0.
            const prevIndex = currentIndex;
            currentIndex = (msg.selectIndex !== undefined &&
                            msg.selectIndex >= 0 &&
                            msg.selectIndex < msg.file.slides.length)
                ? msg.selectIndex
                : (prevIndex >= 0 && prevIndex < msg.file.slides.length ? prevIndex : 0);
            baseStylesCss = msg.baseStylesCss;
            themeCss = msg.themeCss;
            previewBaseHref = msg.previewBaseHref;
            buildUI(msg.file);
            break;
        }

        case 'slideRendered': {
            if (!slidesFile) { break; }
            const slide = slidesFile.slides.find(s => s.index === msg.index);
            if (slide) { slide.sectionHtml = msg.html; }
            if (msg.index === currentIndex) { updatePreviewIframe(); }
            break;
        }

        case 'allRendered': {
            if (!slidesFile) { break; }
            for (const { index, html } of msg.slides) {
                const slide = slidesFile.slides.find(s => s.index === index);
                if (slide) { slide.sectionHtml = html; }
            }
            updatePreviewIframe();
            // Rebuild thumbnails in case slide count changed
            const strip = document.getElementById('thumb-strip');
            if (strip) { rebuildThumbs(strip, slidesFile); }
            break;
        }

        case 'settingsAck': {
            if (!slidesFile) { break; }
            slidesFile.settings = msg.settings;
            themeCss = msg.themeCss;
            // Sync selectors
            const ts = document.getElementById('theme-select') as HTMLSelectElement | null;
            if (ts) { ts.value = msg.settings.theme; }
            const rs = document.getElementById('ratio-select') as HTMLSelectElement | null;
            if (rs) { rs.value = msg.settings.aspectRatio; }
            // Rebuild preview with new theme/ratio (force so correct themeCss is applied)
            updatePreviewIframe(true);
            break;
        }

        case 'editorAnnotation': {
            // TODO: wire to CodeMirror decorations in a later sub-phase
            console.warn('[orz-slides] annotations:', msg.warnings);
            break;
        }
    }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function post(msg: PanelMessage): void {
    vscode.postMessage(msg);
}

function btn(text: string, id: string, title: string, onClick: () => void): HTMLElement {
    const b = document.createElement('button');
    b.id = id;
    b.textContent = text;
    b.title = title;
    b.style.cssText = 'background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:3px 8px;cursor:pointer;border-radius:3px;font-size:12px;';
    b.addEventListener('click', onClick);
    return b;
}

function sep(): HTMLElement {
    const s = document.createElement('div');
    s.style.cssText = 'width:1px;height:18px;background:var(--vscode-editorGroup-border,#444);margin:0 2px;';
    return s;
}

function label(text: string): HTMLElement {
    const l = document.createElement('label');
    l.textContent = text;
    l.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);';
    return l;
}

function selectStyle(): string {
    return 'background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);padding:2px 4px;font-size:11px;border-radius:2px;cursor:pointer;';
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

// Signal ready to extension host
post({ type: 'ready' });
