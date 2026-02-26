/**
 * LocalLeaf PDF Preview Panel
 * Displays compiled PDF using pdf.js in a webview panel
 */

import * as vscode from 'vscode';

export class PdfPreviewPanel {
    static readonly viewType = 'localleaf.pdfPreview';
    private static instance: PdfPreviewPanel | undefined;
    private panel: vscode.WebviewPanel;
    private extensionUri: vscode.Uri;
    private currentPdfPath?: string;
    private disposables: vscode.Disposable[] = [];

    private constructor(extensionUri: vscode.Uri, pdfPath: string) {
        this.extensionUri = extensionUri;
        this.currentPdfPath = pdfPath;

        this.panel = vscode.window.createWebviewPanel(
            PdfPreviewPanel.viewType,
            'PDF Preview',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'media'),
                    // Allow loading PDF from workspace
                    ...(vscode.workspace.workspaceFolders?.map(f => f.uri) || []),
                ],
            }
        );

        // Panel icon (use extension icon path instead of ThemeIcon which isn't supported for panels)

        this.panel.onDidDispose(() => {
            PdfPreviewPanel.instance = undefined;
            this.disposables.forEach(d => d.dispose());
        }, null, this.disposables);

        this.panel.webview.html = this.getWebviewContent(this.panel.webview, pdfPath);
    }

    /**
     * Create or show the PDF preview panel (singleton)
     */
    static createOrShow(extensionUri: vscode.Uri, pdfPath: string): PdfPreviewPanel {
        if (PdfPreviewPanel.instance) {
            PdfPreviewPanel.instance.panel.reveal(vscode.ViewColumn.Beside);
            PdfPreviewPanel.instance.updatePdf(pdfPath);
            return PdfPreviewPanel.instance;
        }

        PdfPreviewPanel.instance = new PdfPreviewPanel(extensionUri, pdfPath);
        return PdfPreviewPanel.instance;
    }

    /**
     * Refresh the PDF display with a new or updated PDF
     */
    updatePdf(pdfPath: string): void {
        this.currentPdfPath = pdfPath;
        const pdfUri = this.panel.webview.asWebviewUri(vscode.Uri.file(pdfPath));

        // Send message to webview to reload PDF (preserving scroll position)
        this.panel.webview.postMessage({
            type: 'updatePdf',
            pdfUrl: pdfUri.toString(),
            timestamp: Date.now(),
        });
    }

    private getWebviewContent(webview: vscode.Webview, pdfPath: string): string {
        const pdfUri = webview.asWebviewUri(vscode.Uri.file(pdfPath));

        // Load pdf.js from media directory
        const pdfJsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'pdf.min.js')
        );
        const pdfWorkerUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'pdf.worker.min.js')
        );
        const viewerJsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'pdfViewer.js')
        );
        const viewerCssUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'pdfViewer.css')
        );

        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src ${webview.cspSource} 'unsafe-inline';
                   script-src 'nonce-${nonce}';
                   img-src ${webview.cspSource} data: blob:;
                   font-src ${webview.cspSource};
                   worker-src blob:;
                   connect-src ${webview.cspSource};">
    <link rel="stylesheet" href="${viewerCssUri}">
    <title>PDF Preview</title>
</head>
<body>
    <div id="toolbar">
        <button id="prev-page" title="Previous Page">&#9664;</button>
        <span id="page-info">Page <span id="page-num">1</span> / <span id="page-count">-</span></span>
        <button id="next-page" title="Next Page">&#9654;</button>
        <span class="separator">|</span>
        <button id="zoom-out" title="Zoom Out">-</button>
        <span id="zoom-level">100%</span>
        <button id="zoom-in" title="Zoom In">+</button>
        <button id="fit-width" title="Fit Width">&#8596;</button>
    </div>
    <div id="viewer-container">
        <div id="viewer"></div>
    </div>

    <script nonce="${nonce}" src="${pdfJsUri}"></script>
    <script nonce="${nonce}" src="${viewerJsUri}"></script>
    <script nonce="${nonce}">
        // Fetch the worker script and create a blob URL so pdf.js can
        // spawn a Web Worker (vscode-resource:// URLs can't be used directly).
        fetch('${pdfWorkerUri}')
            .then(function(r) { return r.text(); })
            .then(function(code) {
                var blob = new Blob([code], { type: 'application/javascript' });
                pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
                // Initialize viewer only after worker is ready
                initViewer('${pdfUri}');
            })
            .catch(function(err) {
                document.getElementById('viewer').innerHTML =
                    '<div class="error-message">Failed to load PDF worker: ' + err.message + '</div>';
            });
    </script>
</body>
</html>`;
    }

    dispose(): void {
        PdfPreviewPanel.instance = undefined;
        this.panel.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
