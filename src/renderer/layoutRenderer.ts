import { LayoutNode } from '../types';
import { renderMarkdown } from './markdownRenderer';

// ─── Layout Renderer ──────────────────────────────────────────────────────────

/**
 * Render a LayoutNode tree to an HTML string.
 * The root node produces the outer `.orz-body` wrapper.
 */
export async function renderLayoutNode(node: LayoutNode): Promise<string> {
    switch (node.kind) {
        case 'root':
            return renderRoot(node);

        case 'col':
            return renderChildren(node.children).then(inner =>
                `<div class="orz-col" style="--orz-frac:${node.frac}" data-orz-label="col ${Math.round(node.frac * 100)}%">${inner}</div>`
            );

        case 'row': {
            const hasCols = node.children.some(c => c.kind === 'col');
            const extraClass = hasCols ? ' has-cols' : '';
            return renderChildren(node.children).then(inner =>
                `<div class="orz-row${extraClass}" style="--orz-frac:${node.frac}" data-orz-label="row ${Math.round(node.frac * 100)}%">${inner}</div>`
            );
        }

        case 'center':
            return renderChildren(node.children).then(inner =>
                `<div class="orz-center" style="--orz-width:${node.width}" data-orz-label="center ${Math.round(node.width * 100)}%">${inner}</div>`
            );

        case 'float':
            return renderChildren(node.children).then(inner =>
                `<div class="orz-float" style="--orz-x:${node.x};--orz-y:${node.y};--orz-w:${node.w}" data-orz-label="float">${inner}</div>`
            );

        case 'footer':
            return renderChildren(node.children).then(inner =>
                `<div class="orz-footer">${inner}</div>`
            );

        case 'note':
            return renderChildren(node.children).then(inner =>
                `<aside class="notes">${inner}</aside>`
            );

        case 'text':
            return renderMarkdown(node.source);

        default:
            return Promise.resolve('');
    }
}

async function renderRoot(node: { kind: 'root'; children: LayoutNode[] }): Promise<string> {
    const children = node.children;

    // Footer nodes must live OUTSIDE orz-body as siblings inside orz-slide-wrap.
    const footerNodes = children.filter(c => c.kind === 'footer');
    const bodyChildren = children.filter(c => c.kind !== 'footer');

    // Determine body modifier from non-footer children
    const hasAnyCols   = bodyChildren.some(c => c.kind === 'col');
    const hasAnyRows   = bodyChildren.some(c => c.kind === 'row');
    const hasAnyCenter = bodyChildren.some(c => c.kind === 'center');

    let bodyClass: string;
    if (hasAnyCols) {
        bodyClass = 'orz-body orz-body-cols';
    } else if (hasAnyRows) {
        bodyClass = 'orz-body orz-body-rows';
    } else if (hasAnyCenter) {
        bodyClass = 'orz-body orz-body-center';
    } else {
        bodyClass = 'orz-body orz-body-plain';
    }

    const inner = await renderChildren(bodyChildren);
    const bodyDiv = `<div class="${bodyClass}">${inner}</div>`;

    const footerParts = await Promise.all(footerNodes.map(c => renderLayoutNode(c)));
    return bodyDiv + footerParts.join('');
}

async function renderChildren(children: LayoutNode[]): Promise<string> {
    const parts = await Promise.all(children.map(c => renderLayoutNode(c)));
    return parts.join('');
}
