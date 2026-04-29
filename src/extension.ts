import * as vscode from 'vscode';
import { SlidesEditorProvider } from './SlidesEditorProvider';

export function activate(context: vscode.ExtensionContext): void {
    // ── Dependency guard ─────────────────────────────────────────────────────
    const dep = vscode.extensions.getExtension('yuwang26.orz-md-preview');
    if (!dep) {
        vscode.window.showErrorMessage(
            'ORZ Slides requires the "ORZ Markdown Preview" extension. Install it from the Marketplace.',
            'Open Marketplace'
        ).then(action => {
            if (action) {
                vscode.commands.executeCommand(
                    'workbench.extensions.search', 'yuwang26.orz-md-preview'
                );
            }
        });
        return;
    }

    // ── Register custom editor ───────────────────────────────────────────────
    const provider = new SlidesEditorProvider(context);
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            'orz-slides.editor',
            provider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true,
                },
                supportsMultipleEditorsPerDocument: false,
            }
        )
    );

    // ── Commands ─────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('orz-slides.openInBrowser', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                vscode.env.openExternal(vscode.Uri.file(editor.document.uri.fsPath));
            }
        })
    );
}

export function deactivate(): void {
    // nothing to clean up
}
