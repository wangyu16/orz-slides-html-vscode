// ─────────────────────────────────────────────────────────────────────────────
// Shared types used across the extension
// ─────────────────────────────────────────────────────────────────────────────

export interface DeckSettings {
    theme: string;
    aspectRatio: '16:9' | '4:3' | '16:10' | '1:1';
    transition: string;
}

export interface DeckMeta {
    author?: string;
    affiliation?: string;
    date?: string;
    [key: string]: string | undefined;
}

export interface SlideData {
    /** 0-based index matching data-index attribute */
    index: number;
    /** Raw source: markdown + [[ ]] layout syntax */
    source: string;
    /** Current pre-rendered HTML content of the <section> */
    sectionHtml: string;
}

export interface SlidesFile {
    settings: DeckSettings;
    meta: DeckMeta;
    slides: SlideData[];
}

// ─── Message protocol ─────────────────────────────────────────────────────────

/** Messages sent from extension host → webview */
export type ExtMessage =
    | InitMessage
    | { type: 'slideRendered'; index: number; html: string }
    | { type: 'allRendered';  slides: { index: number; html: string }[] }
    | { type: 'settingsAck';  settings: DeckSettings; themeCss: string }
    | { type: 'editorAnnotation'; index: number; warnings: LayoutWarning[] };

// init carries inline CSS so the srcdoc preview doesn't need local file access
export type InitMessage = {
    type: 'init';
    file: SlidesFile;
    baseStylesCss: string;
    themeCss: string;
    previewBaseHref: string;
    /** If set, the webview should select this slide index after loading. */
    selectIndex?: number;
};

/** Messages sent from webview → extension host */
export type PanelMessage =
    | { type: 'ready' }
    | { type: 'contentChanged'; index: number; source: string }
    | { type: 'saveFile';       index: number; source: string }
    | { type: 'settingsChanged'; settings: DeckSettings }
    | { type: 'navigateTo';     index: number }
    | { type: 'addSlide';    afterIndex: number; pendingIndex: number; pendingSource: string }
    | { type: 'deleteSlide'; index: number;      pendingIndex: number; pendingSource: string };

export interface LayoutWarning {
    message: string;
    line?: number;
    severity: 'warning' | 'error';
}

// ─── Layout tree (shared between parser, renderer, and webview types) ─────────

export type LayoutNode =
    | { kind: 'root';   children: LayoutNode[] }
    | { kind: 'col';    frac: number;  children: LayoutNode[] }
    | { kind: 'row';    frac: number;  children: LayoutNode[] }
    | { kind: 'center'; width: number; children: LayoutNode[] }
    | { kind: 'float';  x: number; y: number; w: number; children: LayoutNode[] }
    | { kind: 'footer'; children: LayoutNode[] }
    | { kind: 'note';   children: LayoutNode[] }
    | { kind: 'text';   source: string };

export interface ParseWarning {
    message: string;
    depth: number;
    severity: 'warning' | 'error';
}
