/**
 * LocalLeaf PDF Preview Panel
 * Displays compiled PDF using pdf.js in a webview panel.
 * Supports SyncTeX inverse search (double-click → jump to source).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';
import { LatexCompiler } from '../compilation/latexCompiler';

export class PdfPreviewPanel {
    static readonly viewType = 'localleaf.pdfPreview';
    private static instance: PdfPreviewPanel | undefined;
    private panel: vscode.WebviewPanel;
    private extensionUri: vscode.Uri;
    private currentPdfPath?: string;
    private workspaceFolder: string;
    private disposables: vscode.Disposable[] = [];

    private constructor(extensionUri: vscode.Uri, pdfPath: string, workspaceFolder: string) {
        this.extensionUri = extensionUri;
        this.currentPdfPath = pdfPath;
        this.workspaceFolder = workspaceFolder;

        const buildDir = LatexCompiler.getBuildDir(workspaceFolder);

        this.panel = vscode.window.createWebviewPanel(
            PdfPreviewPanel.viewType,
            'PDF Preview',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'media'),
                    vscode.Uri.file(buildDir),
                    ...(vscode.workspace.workspaceFolders?.map(f => f.uri) || []),
                ],
            }
        );

        this.panel.onDidDispose(() => {
            PdfPreviewPanel.instance = undefined;
            this.disposables.forEach(d => d.dispose());
        }, null, this.disposables);

        // Listen for messages from the webview (synctex clicks)
        this.panel.webview.onDidReceiveMessage(
            msg => this.handleWebviewMessage(msg),
            null,
            this.disposables
        );

        this.panel.webview.html = this.getWebviewContent(this.panel.webview, pdfPath);
    }

    /**
     * Create or show the PDF preview panel (singleton)
     */
    static createOrShow(extensionUri: vscode.Uri, pdfPath: string, workspaceFolder?: string): PdfPreviewPanel {
        const wsFolder = workspaceFolder
            || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            || path.dirname(pdfPath);

        if (PdfPreviewPanel.instance) {
            PdfPreviewPanel.instance.workspaceFolder = wsFolder;
            PdfPreviewPanel.instance.panel.reveal(vscode.ViewColumn.Beside);
            PdfPreviewPanel.instance.updatePdf(pdfPath);
            return PdfPreviewPanel.instance;
        }

        PdfPreviewPanel.instance = new PdfPreviewPanel(extensionUri, pdfPath, wsFolder);
        return PdfPreviewPanel.instance;
    }

    /**
     * Refresh the PDF display with a new or updated PDF
     */
    updatePdf(pdfPath: string): void {
        this.currentPdfPath = pdfPath;
        const pdfUri = this.panel.webview.asWebviewUri(vscode.Uri.file(pdfPath));
        // Append cache-busting query param so pdf.js re-fetches the file
        this.panel.webview.postMessage({
            type: 'updatePdf',
            pdfUrl: pdfUri.toString() + '?t=' + Date.now(),
        });
    }

    // ─── Webview message handler ─────────────────────────────────

    private handleWebviewMessage(msg: { type: string; page?: number; x?: number; y?: number }) {
        if (msg.type === 'synctexClick' && msg.page && msg.x !== undefined && msg.y !== undefined) {
            this.synctexInverseSearch(msg.page, msg.x, msg.y);
        }
    }

    // ─── SyncTeX inverse search ──────────────────────────────────

    private synctexInverseSearch(page: number, x: number, y: number) {
        if (!this.currentPdfPath) return;

        // Use path relative to workspace to avoid Windows drive-letter colon
        // conflicting with the page:x:y:file format
        const relPdf = path.relative(this.workspaceFolder, this.currentPdfPath);

        const args = [
            'edit',
            '-o',
            `${page}:${x.toFixed(2)}:${y.toFixed(2)}:${relPdf}`,
        ];

        console.log('[LocalLeaf] synctex', args.join(' '));

        const proc = spawn('synctex', args, {
            cwd: this.workspaceFolder,
            shell: true,
            stdio: 'pipe',
        });

        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
        proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

        proc.on('close', (code) => {
            console.log('[LocalLeaf] synctex exit', code, 'stdout:', stdout.substring(0, 300));
            if (stderr) {
                console.log('[LocalLeaf] synctex stderr:', stderr.substring(0, 300));
            }

            const result = this.parseSynctexOutput(stdout);
            if (result) {
                this.openSourceLocation(result.file, result.line, result.column);
            } else if (code !== 0) {
                vscode.window.showWarningMessage(
                    'LocalLeaf: SyncTeX inverse search failed. Make sure synctex is installed (comes with TeX Live / MiKTeX).'
                );
            }
        });

        proc.on('error', (err) => {
            console.log('[LocalLeaf] synctex spawn error:', err.message);
            vscode.window.showWarningMessage(
                'LocalLeaf: Could not run synctex command. Make sure a TeX distribution (TeX Live / MiKTeX) is installed.'
            );
        });
    }

    private parseSynctexOutput(output: string): { file: string; line: number; column: number } | null {
        // synctex edit output looks like:
        //   Output:...
        //   Input:./main.tex
        //   Line:42
        //   Column:0
        //   ...
        let file = '';
        let line = 0;
        let column = 0;

        for (const raw of output.split('\n')) {
            const l = raw.trim();
            if (l.startsWith('Input:')) {
                file = l.substring('Input:'.length);
            } else if (l.startsWith('Line:')) {
                line = parseInt(l.substring('Line:'.length), 10) || 0;
            } else if (l.startsWith('Column:')) {
                column = parseInt(l.substring('Column:'.length), 10) || 0;
            }
        }

        if (!file || line <= 0) return null;

        // Resolve relative paths against workspace
        if (!path.isAbsolute(file)) {
            file = path.join(this.workspaceFolder, file);
        }

        return { file, line, column };
    }

    private async openSourceLocation(filePath: string, line: number, column: number) {
        try {
            const uri = vscode.Uri.file(filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            const pos = new vscode.Position(Math.max(0, line - 1), column);
            // preserveFocus: true keeps the PDF panel focused so
            // subsequent double-clicks continue to work immediately
            const editor = await vscode.window.showTextDocument(doc, {
                viewColumn: vscode.ViewColumn.One,
                selection: new vscode.Range(pos, pos),
                preserveFocus: true,
            });
            editor.revealRange(
                new vscode.Range(pos, pos),
                vscode.TextEditorRevealType.InCenter
            );
        } catch {
            // File may not exist — ignore
        }
    }

    // ─── Webview HTML ────────────────────────────────────────────

    private getWebviewContent(webview: vscode.Webview, pdfPath: string): string {
        const pdfUri = webview.asWebviewUri(vscode.Uri.file(pdfPath));

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
        <button id="zoom-out" title="Zoom Out">&#8722;</button>
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
        fetch('${pdfWorkerUri}')
            .then(function(r) { return r.text(); })
            .then(function(code) {
                var blob = new Blob([code], { type: 'application/javascript' });
                pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
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
