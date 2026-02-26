/**
 * LocalLeaf PDF Viewer Script
 * Uses pdf.js to render PDF pages in a VS Code webview
 */

/* global pdfjsLib */

let pdfDoc = null;
let currentPage = 1;
let totalPages = 0;
let zoomLevel = 1.0;
let rendering = false;
let pendingPage = null;
let scrollPosition = 0;

const viewer = document.getElementById('viewer');
const viewerContainer = document.getElementById('viewer-container');
const pageNum = document.getElementById('page-num');
const pageCount = document.getElementById('page-count');
const zoomDisplay = document.getElementById('zoom-level');

// VS Code API for messaging
const vscode = acquireVsCodeApi();

/**
 * Initialize the PDF viewer with a URL
 */
function initViewer(url) {
    loadPdf(url);
}

/**
 * Load a PDF from a URL
 */
async function loadPdf(url) {
    try {
        // Save current scroll position
        scrollPosition = viewerContainer.scrollTop;

        const loadingTask = pdfjsLib.getDocument(url);
        pdfDoc = await loadingTask.promise;
        totalPages = pdfDoc.numPages;
        pageCount.textContent = totalPages;

        // Render all visible pages
        await renderAllPages();

        // Restore scroll position
        viewerContainer.scrollTop = scrollPosition;
    } catch (error) {
        viewer.innerHTML = '<div class="error-message">Failed to load PDF: ' + error.message + '</div>';
    }
}

/**
 * Render all pages (continuous scroll mode)
 */
async function renderAllPages() {
    viewer.innerHTML = '';

    for (let i = 1; i <= totalPages; i++) {
        const page = await pdfDoc.getPage(i);
        const viewport = page.getViewport({ scale: zoomLevel });

        const pageDiv = document.createElement('div');
        pageDiv.className = 'pdf-page';
        pageDiv.dataset.pageNum = i;

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');

        // Handle high DPI displays
        const dpr = window.devicePixelRatio || 1;
        canvas.width = viewport.width * dpr;
        canvas.height = viewport.height * dpr;
        canvas.style.width = viewport.width + 'px';
        canvas.style.height = viewport.height + 'px';
        context.scale(dpr, dpr);

        pageDiv.appendChild(canvas);
        viewer.appendChild(pageDiv);

        await page.render({
            canvasContext: context,
            viewport: viewport,
        }).promise;
    }

    updatePageIndicator();
}

/**
 * Render a single page (for page navigation mode)
 */
async function renderPage(num) {
    if (rendering) {
        pendingPage = num;
        return;
    }

    rendering = true;
    currentPage = num;
    pageNum.textContent = num;

    const page = await pdfDoc.getPage(num);
    const viewport = page.getViewport({ scale: zoomLevel });

    viewer.innerHTML = '';
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');

    const dpr = window.devicePixelRatio || 1;
    canvas.width = viewport.width * dpr;
    canvas.height = viewport.height * dpr;
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    context.scale(dpr, dpr);

    viewer.appendChild(canvas);

    await page.render({
        canvasContext: context,
        viewport: viewport,
    }).promise;

    rendering = false;
    if (pendingPage !== null) {
        const next = pendingPage;
        pendingPage = null;
        renderPage(next);
    }
}

/**
 * Update page indicator based on scroll position
 */
function updatePageIndicator() {
    const pages = viewer.querySelectorAll('.pdf-page');
    const containerTop = viewerContainer.scrollTop;
    const containerCenter = containerTop + viewerContainer.clientHeight / 2;

    for (const page of pages) {
        const pageTop = page.offsetTop;
        const pageBottom = pageTop + page.offsetHeight;

        if (containerCenter >= pageTop && containerCenter <= pageBottom) {
            currentPage = parseInt(page.dataset.pageNum, 10);
            pageNum.textContent = currentPage;
            break;
        }
    }
}

// Scroll listener for page indicator
viewerContainer.addEventListener('scroll', () => {
    updatePageIndicator();
});

// Toolbar buttons
document.getElementById('prev-page').addEventListener('click', () => {
    if (currentPage <= 1) return;
    const pages = viewer.querySelectorAll('.pdf-page');
    const targetPage = pages[currentPage - 2];
    if (targetPage) {
        targetPage.scrollIntoView({ behavior: 'smooth' });
    }
});

document.getElementById('next-page').addEventListener('click', () => {
    if (currentPage >= totalPages) return;
    const pages = viewer.querySelectorAll('.pdf-page');
    const targetPage = pages[currentPage];
    if (targetPage) {
        targetPage.scrollIntoView({ behavior: 'smooth' });
    }
});

document.getElementById('zoom-in').addEventListener('click', () => {
    zoomLevel = Math.min(zoomLevel + 0.25, 5.0);
    zoomDisplay.textContent = Math.round(zoomLevel * 100) + '%';
    renderAllPages();
});

document.getElementById('zoom-out').addEventListener('click', () => {
    zoomLevel = Math.max(zoomLevel - 0.25, 0.25);
    zoomDisplay.textContent = Math.round(zoomLevel * 100) + '%';
    renderAllPages();
});

document.getElementById('fit-width').addEventListener('click', async () => {
    if (!pdfDoc) return;
    const page = await pdfDoc.getPage(1);
    const viewport = page.getViewport({ scale: 1.0 });
    const containerWidth = viewerContainer.clientWidth - 20; // 20px padding
    zoomLevel = containerWidth / viewport.width;
    zoomDisplay.textContent = Math.round(zoomLevel * 100) + '%';
    renderAllPages();
});

// Listen for messages from the extension
window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'updatePdf') {
        loadPdf(message.pdfUrl);
    }
});
