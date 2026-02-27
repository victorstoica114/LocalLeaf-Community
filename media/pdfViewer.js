/**
 * LocalLeaf PDF Viewer Script
 * Uses pdf.js to render PDF pages in a VS Code webview.
 * Features: text selection, Ctrl+wheel zoom, Ctrl+click SyncTeX inverse search.
 */

/* global pdfjsLib */

let pdfDoc = null;
let currentPage = 1;
let totalPages = 0;
let zoomLevel = 1.0;
let rendering = false;
let pendingRender = false;
let scrollPosition = 0;

const viewer = document.getElementById('viewer');
const viewerContainer = document.getElementById('viewer-container');
const pageNum = document.getElementById('page-num');
const pageCount = document.getElementById('page-count');
const zoomDisplay = document.getElementById('zoom-level');

const vscode = acquireVsCodeApi();

// ─── Initialisation ──────────────────────────────────────────────

function initViewer(url) {
    loadPdf(url);
}

async function loadPdf(url) {
    try {
        scrollPosition = viewerContainer.scrollTop;

        // Fetch raw bytes with cache: 'no-store' to bypass browser / webview
        // resource-server caching, then hand the ArrayBuffer to pdf.js.
        var resp = await fetch(url, { cache: 'no-store' });
        var data = await resp.arrayBuffer();

        await openPdfData(data);
    } catch (error) {
        viewer.innerHTML = '<div class="error-message">Failed to load PDF: ' + error.message + '</div>';
    }
}

async function loadPdfFromBase64(base64) {
    try {
        scrollPosition = viewerContainer.scrollTop;

        var raw = atob(base64);
        var bytes = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) {
            bytes[i] = raw.charCodeAt(i);
        }

        await openPdfData(bytes.buffer);
    } catch (error) {
        viewer.innerHTML = '<div class="error-message">Failed to load PDF: ' + error.message + '</div>';
    }
}

async function openPdfData(data) {
    // Destroy previous document to free memory
    if (pdfDoc) {
        try { pdfDoc.destroy(); } catch (_) {}
    }

    pdfDoc = await pdfjsLib.getDocument({ data: data }).promise;
    totalPages = pdfDoc.numPages;
    pageCount.textContent = totalPages;

    await renderAllPages();
    viewerContainer.scrollTop = scrollPosition;
}

// ─── Rendering (canvas + text layer) ─────────────────────────────

async function renderAllPages() {
    if (rendering) { pendingRender = true; return; }
    rendering = true;
    viewer.innerHTML = '';

    for (var i = 1; i <= totalPages; i++) {
        var page = await pdfDoc.getPage(i);
        var viewport = page.getViewport({ scale: zoomLevel });

        // Wrapper (relative position so text layer overlaps canvas)
        var pageDiv = document.createElement('div');
        pageDiv.className = 'pdf-page';
        pageDiv.dataset.pageNum = i;
        pageDiv.style.width = viewport.width + 'px';
        pageDiv.style.height = viewport.height + 'px';

        // Canvas
        var canvas = document.createElement('canvas');
        var ctx = canvas.getContext('2d');
        var dpr = window.devicePixelRatio || 1;
        canvas.width = viewport.width * dpr;
        canvas.height = viewport.height * dpr;
        canvas.style.width = viewport.width + 'px';
        canvas.style.height = viewport.height + 'px';
        ctx.scale(dpr, dpr);
        pageDiv.appendChild(canvas);

        // Text layer (transparent text for selection)
        var textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'textLayer';
        pageDiv.appendChild(textLayerDiv);

        viewer.appendChild(pageDiv);

        // Render canvas
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;

        // Render text layer
        try {
            var textContent = await page.getTextContent();
            pdfjsLib.renderTextLayer({
                textContent: textContent,
                container: textLayerDiv,
                viewport: viewport,
                textDivs: [],
            });
        } catch (_) {
            // text layer not critical — ignore if unavailable
        }
    }

    updatePageIndicator();
    rendering = false;
    if (pendingRender) { pendingRender = false; renderAllPages(); }
}

// ─── Page indicator ──────────────────────────────────────────────

function updatePageIndicator() {
    var pages = viewer.querySelectorAll('.pdf-page');
    var top = viewerContainer.scrollTop;
    var center = top + viewerContainer.clientHeight / 2;
    for (var i = 0; i < pages.length; i++) {
        var p = pages[i];
        if (center >= p.offsetTop && center <= p.offsetTop + p.offsetHeight) {
            currentPage = parseInt(p.dataset.pageNum, 10);
            pageNum.textContent = currentPage;
            break;
        }
    }
}

viewerContainer.addEventListener('scroll', updatePageIndicator);

// ─── Zoom helpers ────────────────────────────────────────────────

function applyZoom(newZoom) {
    newZoom = Math.min(Math.max(newZoom, 0.1), 10.0);
    if (Math.abs(newZoom - zoomLevel) < 0.001) return;

    var ratio = viewerContainer.scrollHeight > 0
        ? viewerContainer.scrollTop / viewerContainer.scrollHeight : 0;

    zoomLevel = newZoom;
    zoomDisplay.textContent = Math.round(zoomLevel * 100) + '%';
    renderAllPages().then(function () {
        viewerContainer.scrollTop = ratio * viewerContainer.scrollHeight;
    });
}

// Ctrl + scroll-wheel zoom
viewerContainer.addEventListener('wheel', function (e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    var delta = e.deltaY > 0 ? -0.1 : 0.1;
    applyZoom(zoomLevel + delta);
}, { passive: false });

// ─── Recompile button ────────────────────────────────────────────

var recompileBtn = document.getElementById('recompile-btn');

recompileBtn.addEventListener('click', function () {
    if (recompileBtn.classList.contains('compiling')) return;
    vscode.postMessage({ type: 'recompile' });
});

function setCompilingState(compiling) {
    if (compiling) {
        recompileBtn.classList.add('compiling');
        recompileBtn.innerHTML = '<span class="spinner"></span>Compiling';
    } else {
        recompileBtn.classList.remove('compiling');
        recompileBtn.textContent = 'Recompile';
    }
}

// ─── Toolbar buttons ─────────────────────────────────────────────

document.getElementById('prev-page').addEventListener('click', function () {
    if (currentPage <= 1) return;
    var t = viewer.querySelectorAll('.pdf-page')[currentPage - 2];
    if (t) t.scrollIntoView({ behavior: 'smooth' });
});
document.getElementById('next-page').addEventListener('click', function () {
    if (currentPage >= totalPages) return;
    var t = viewer.querySelectorAll('.pdf-page')[currentPage];
    if (t) t.scrollIntoView({ behavior: 'smooth' });
});
document.getElementById('zoom-in').addEventListener('click', function () {
    applyZoom(zoomLevel + 0.25);
});
document.getElementById('zoom-out').addEventListener('click', function () {
    applyZoom(zoomLevel - 0.25);
});
document.getElementById('fit-width').addEventListener('click', async function () {
    if (!pdfDoc) return;
    var vp = (await pdfDoc.getPage(1)).getViewport({ scale: 1.0 });
    applyZoom((viewerContainer.clientWidth - 20) / vp.width);
});

// ─── Double-click → SyncTeX inverse search ───────────────────────

viewer.addEventListener('dblclick', function (e) {
    var target = e.target;
    var targetElement = target instanceof Element
        ? target
        : (target instanceof Node ? target.parentElement : null);
    if (!targetElement) return;

    var pageDiv = targetElement.closest('.pdf-page');
    if (!pageDiv) return;

    var pageNumber = parseInt(pageDiv.dataset.pageNum, 10);
    var rect = pageDiv.getBoundingClientRect();
    var clickX = e.clientX - rect.left;
    var clickY = e.clientY - rect.top;

    // Convert CSS pixels → PDF points (scale-1 units ≈ 1/72 inch)
    var pdfX = clickX / zoomLevel;
    var pdfY = clickY / zoomLevel;

    vscode.postMessage({ type: 'synctexClick', page: pageNumber, x: pdfX, y: pdfY });
});

// ─── Messages from extension ─────────────────────────────────────

window.addEventListener('message', function (event) {
    var msg = event.data;
    if (msg.type === 'updatePdf') {
        if (msg.pdfData) {
            loadPdfFromBase64(msg.pdfData);
        } else {
            loadPdf(msg.pdfUrl);
        }
    } else if (msg.type === 'setCompiling') {
        setCompilingState(msg.compiling);
    }
});
