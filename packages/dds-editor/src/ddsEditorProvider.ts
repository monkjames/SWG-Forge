import * as vscode from 'vscode';
import { decodeDDS, encodeDDS, DDSInfo } from './ddsCodec';

// ─── Document ────────────────────────────────────────────────────────────────

class DDSDocument implements vscode.CustomDocument {
    public info: DDSInfo;
    public rgba: Uint8Array;
    public originalFourCC: string;
    public error: string | null = null;

    constructor(
        public readonly uri: vscode.Uri,
        fileData: Uint8Array
    ) {
        try {
            const image = decodeDDS(fileData);
            this.info = image.info;
            this.rgba = image.rgba;
            this.originalFourCC = image.info.fourCC;
        } catch (e) {
            this.error = e instanceof Error ? e.message : String(e);
            this.info = { width: 0, height: 0, mipCount: 0, fourCC: '???', fileSize: fileData.length };
            this.rgba = new Uint8Array(0);
            this.originalFourCC = '';
        }
    }

    public reload(fileData: Uint8Array): void {
        try {
            const image = decodeDDS(fileData);
            this.info = image.info;
            this.rgba = image.rgba;
            this.error = null;
        } catch (e) {
            this.error = e instanceof Error ? e.message : String(e);
        }
    }

    public dispose(): void {}
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class DDSEditorProvider implements vscode.CustomEditorProvider<DDSDocument> {
    public static readonly viewType = 'ddsEditor.ddsFile';

    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<DDSDocument>>();
    public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    private webviewPanels = new Map<string, vscode.WebviewPanel>();

    constructor(private readonly context: vscode.ExtensionContext) {}

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new DDSEditorProvider(context);
        return vscode.window.registerCustomEditorProvider(
            DDSEditorProvider.viewType,
            provider,
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false
            }
        );
    }

    async openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<DDSDocument> {
        const data = await vscode.workspace.fs.readFile(uri);
        return new DDSDocument(uri, data);
    }

    async resolveCustomEditor(
        document: DDSDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        const key = document.uri.toString();
        this.webviewPanels.set(key, webviewPanel);
        webviewPanel.onDidDispose(() => this.webviewPanels.delete(key));

        webviewPanel.webview.options = { enableScripts: true };
        webviewPanel.webview.html = this.getHtmlForWebview();

        webviewPanel.webview.onDidReceiveMessage(e => {
            switch (e.type) {
                case 'ready':
                    this.sendLoad(document, webviewPanel);
                    break;
                case 'edit':
                    this.handleEdit(document, e.width, e.height, e.rgbaBase64, webviewPanel);
                    break;
            }
        });
    }

    private sendLoad(document: DDSDocument, panel: vscode.WebviewPanel): void {
        if (document.error) {
            panel.webview.postMessage({
                type: 'error',
                message: document.error,
                fileName: document.uri.fsPath.split('/').pop() || 'unknown',
                fileSize: document.info.fileSize
            });
            return;
        }
        const rgbaBase64 = Buffer.from(document.rgba).toString('base64');
        panel.webview.postMessage({
            type: 'load',
            width: document.info.width,
            height: document.info.height,
            fourCC: document.info.fourCC,
            mipCount: document.info.mipCount,
            fileSize: document.info.fileSize,
            rgbaBase64
        });
    }

    private sendUpdatePixels(document: DDSDocument, panel: vscode.WebviewPanel): void {
        const rgbaBase64 = Buffer.from(document.rgba).toString('base64');
        panel.webview.postMessage({
            type: 'updatePixels',
            width: document.info.width,
            height: document.info.height,
            rgbaBase64
        });
    }

    private handleEdit(document: DDSDocument, newWidth: number, newHeight: number, rgbaBase64: string, panel: vscode.WebviewPanel): void {
        const oldRgba = document.rgba;
        const oldWidth = document.info.width;
        const oldHeight = document.info.height;

        const newRgba = new Uint8Array(Buffer.from(rgbaBase64, 'base64'));
        document.rgba = newRgba;
        document.info.width = newWidth;
        document.info.height = newHeight;

        this._onDidChangeCustomDocument.fire({
            document,
            undo: () => {
                document.rgba = oldRgba;
                document.info.width = oldWidth;
                document.info.height = oldHeight;
                this.sendUpdatePixels(document, panel);
            },
            redo: () => {
                document.rgba = newRgba;
                document.info.width = newWidth;
                document.info.height = newHeight;
                this.sendUpdatePixels(document, panel);
            }
        });
    }

    async saveCustomDocument(document: DDSDocument, _cancellation: vscode.CancellationToken): Promise<void> {
        if (document.error) {
            vscode.window.showWarningMessage('Cannot save: this DDS file could not be decoded.');
            return;
        }
        const fourCC = (document.originalFourCC === 'DXT1') ? 'DXT1' : 'DXT5';
        const encoded = encodeDDS(document.rgba, document.info.width, document.info.height, fourCC);
        await vscode.workspace.fs.writeFile(document.uri, encoded);
        document.info.fileSize = encoded.length;
        document.info.mipCount = Math.floor(Math.log2(Math.max(document.info.width, document.info.height))) + 1;
    }

    async saveCustomDocumentAs(document: DDSDocument, destination: vscode.Uri, _cancellation: vscode.CancellationToken): Promise<void> {
        if (document.error) {
            vscode.window.showWarningMessage('Cannot save: this DDS file could not be decoded.');
            return;
        }
        const fourCC = (document.originalFourCC === 'DXT1') ? 'DXT1' : 'DXT5';
        const encoded = encodeDDS(document.rgba, document.info.width, document.info.height, fourCC);
        await vscode.workspace.fs.writeFile(destination, encoded);
    }

    async revertCustomDocument(document: DDSDocument, _cancellation: vscode.CancellationToken): Promise<void> {
        const data = await vscode.workspace.fs.readFile(document.uri);
        document.reload(data);
        const panel = this.webviewPanels.get(document.uri.toString());
        if (panel) { this.sendLoad(document, panel); }
    }

    async backupCustomDocument(document: DDSDocument, context: vscode.CustomDocumentBackupContext, _cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        if (document.error) {
            // Nothing to back up for a failed decode - write empty marker
            await vscode.workspace.fs.writeFile(context.destination, new Uint8Array(0));
            return {
                id: context.destination.toString(),
                delete: () => vscode.workspace.fs.delete(context.destination)
            };
        }
        const fourCC = (document.originalFourCC === 'DXT1') ? 'DXT1' : 'DXT5';
        const encoded = encodeDDS(document.rgba, document.info.width, document.info.height, fourCC);
        await vscode.workspace.fs.writeFile(context.destination, encoded);
        return {
            id: context.destination.toString(),
            delete: () => vscode.workspace.fs.delete(context.destination)
        };
    }

    // ─── Webview HTML ────────────────────────────────────────────────────────

    private getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DDS Editor</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }

body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
    user-select: none;
}

/* ── Info Bar ── */
.info-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 12px;
    background: var(--vscode-toolbar-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 12px;
    flex-shrink: 0;
}

.info-badge {
    padding: 2px 8px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 3px;
    font-weight: 600;
}

.info-item { color: var(--vscode-descriptionForeground); }

/* ── Main Layout ── */
.main-area {
    display: flex;
    flex: 1;
    overflow: hidden;
}

/* ── Toolbar ── */
.toolbar {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 4px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-right: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
    width: 44px;
}

.tool-btn {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    font-size: 16px;
    padding: 0;
}

.tool-btn:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15));
    border-color: var(--vscode-panel-border);
}

.tool-btn.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
}

.tool-sep {
    height: 1px;
    margin: 4px 6px;
    background: var(--vscode-panel-border);
}

/* ── Canvas Area ── */
.canvas-container {
    flex: 1;
    overflow: hidden;
    position: relative;
    cursor: grab;
}

.canvas-container.crop-mode { cursor: crosshair; }
.canvas-container.dragging { cursor: grabbing; }

.checkerboard {
    position: absolute;
    top: 0; left: 0;
    background-image:
        linear-gradient(45deg, #808080 25%, transparent 25%),
        linear-gradient(-45deg, #808080 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, #808080 75%),
        linear-gradient(-45deg, transparent 75%, #808080 75%);
    background-size: 16px 16px;
    background-position: 0 0, 0 8px, 8px -8px, -8px 0;
    pointer-events: none;
}

#mainCanvas {
    position: absolute;
    top: 0; left: 0;
    image-rendering: pixelated;
}

#overlayCanvas {
    position: absolute;
    top: 0; left: 0;
    pointer-events: none;
}

/* ── Adjustment Panel ── */
.adjust-panel {
    padding: 8px 12px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-top: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
}

.adjust-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
}

.adjust-label {
    width: 80px;
    text-align: right;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
}

.adjust-slider {
    flex: 1;
    height: 4px;
    -webkit-appearance: none;
    appearance: none;
    background: var(--vscode-input-background);
    border-radius: 2px;
    outline: none;
}

.adjust-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--vscode-button-background);
    cursor: pointer;
}

.adjust-value {
    width: 36px;
    text-align: center;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
}

.adjust-buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 6px;
}

.adj-btn {
    padding: 4px 14px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font-size: 12px;
}

.adj-btn:hover { background: var(--vscode-button-hoverBackground); }

.adj-btn.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
}

/* ── Resize Dialog ── */
.dialog-overlay {
    display: none;
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.5);
    z-index: 100;
    align-items: center;
    justify-content: center;
}

.dialog-overlay.visible { display: flex; }

.dialog-box {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 20px;
    min-width: 280px;
}

.dialog-title {
    font-weight: 600;
    font-size: 14px;
    margin-bottom: 12px;
}

.dialog-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
}

.dialog-row label {
    width: 60px;
    font-size: 12px;
}

.dialog-row select, .dialog-row input {
    flex: 1;
    padding: 4px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 3px;
    font-size: 12px;
}

.dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
}

/* ── Crop confirm bar ── */
.crop-bar {
    display: none;
    position: absolute;
    bottom: 8px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 50;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 6px 12px;
    gap: 8px;
    align-items: center;
    font-size: 12px;
}

.crop-bar.visible { display: flex; }

/* ── Error Overlay ── */
.error-overlay {
    display: none;
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    z-index: 200;
    background: var(--vscode-editor-background);
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 16px;
    padding: 40px;
    text-align: center;
}

.error-overlay.visible { display: flex; }

.error-icon {
    font-size: 48px;
    opacity: 0.5;
}

.error-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--vscode-errorForeground, #f44);
}

.error-detail {
    font-size: 13px;
    color: var(--vscode-descriptionForeground);
    max-width: 500px;
    line-height: 1.5;
    word-break: break-word;
}

.error-filename {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.7;
    font-family: var(--vscode-editor-font-family);
}
</style>
</head>
<body>

<!-- Info Bar -->
<div class="info-bar">
    <span class="info-badge" id="infoBadge">DXT5</span>
    <span class="info-item" id="infoDims">0 x 0</span>
    <span class="info-item" id="infoMips">0 mips</span>
    <span class="info-item" id="infoSize">0 KB</span>
    <span class="info-item" id="infoZoom">100%</span>
</div>

<!-- Main Area -->
<div class="main-area">
    <!-- Toolbar -->
    <div class="toolbar">
        <button class="tool-btn" id="btnCrop" title="Crop (C)">&#x2702;</button>
        <button class="tool-btn" id="btnResize" title="Resize">&#x21F2;</button>
        <div class="tool-sep"></div>
        <button class="tool-btn" id="btnFlipH" title="Flip Horizontal">&#x21C4;</button>
        <button class="tool-btn" id="btnFlipV" title="Flip Vertical">&#x21C5;</button>
        <div class="tool-sep"></div>
        <button class="tool-btn" id="btnRotCW" title="Rotate 90 CW">&#x21BB;</button>
        <button class="tool-btn" id="btnRotCCW" title="Rotate 90 CCW">&#x21BA;</button>
        <button class="tool-btn" id="btnRot180" title="Rotate 180">&#x21C6;</button>
        <div class="tool-sep"></div>
        <button class="tool-btn" id="btnFitView" title="Fit to View (F)">&#x2922;</button>
        <button class="tool-btn" id="btnActualSize" title="Actual Size (1)">1:1</button>
    </div>

    <!-- Canvas -->
    <div class="canvas-container" id="canvasContainer">
        <div class="checkerboard" id="checkerboard"></div>
        <canvas id="mainCanvas"></canvas>
        <canvas id="overlayCanvas"></canvas>

        <!-- Error overlay -->
        <div class="error-overlay" id="errorOverlay">
            <div class="error-icon">&#x26A0;</div>
            <div class="error-title" id="errorTitle">Unable to open DDS file</div>
            <div class="error-detail" id="errorDetail"></div>
            <div class="error-filename" id="errorFilename"></div>
        </div>

        <!-- Crop confirm bar -->
        <div class="crop-bar" id="cropBar">
            <span id="cropInfo">0 x 0</span>
            <button class="adj-btn" id="cropApply">Apply Crop</button>
            <button class="adj-btn secondary" id="cropCancel">Cancel</button>
        </div>
    </div>
</div>

<!-- Adjustment Panel -->
<div class="adjust-panel">
    <div class="adjust-row">
        <span class="adjust-label">Brightness</span>
        <input type="range" class="adjust-slider" id="slBrightness" min="-100" max="100" value="0">
        <span class="adjust-value" id="valBrightness">0</span>
        <span class="adjust-label">Contrast</span>
        <input type="range" class="adjust-slider" id="slContrast" min="-100" max="100" value="0">
        <span class="adjust-value" id="valContrast">0</span>
    </div>
    <div class="adjust-row">
        <span class="adjust-label">Saturation</span>
        <input type="range" class="adjust-slider" id="slSaturation" min="-100" max="100" value="0">
        <span class="adjust-value" id="valSaturation">0</span>
        <span class="adjust-label">Hue Shift</span>
        <input type="range" class="adjust-slider" id="slHue" min="-180" max="180" value="0">
        <span class="adjust-value" id="valHue">0</span>
    </div>
    <div class="adjust-buttons">
        <button class="adj-btn secondary" id="btnAdjReset">Reset</button>
        <button class="adj-btn" id="btnAdjApply">Apply</button>
    </div>
</div>

<!-- Resize Dialog -->
<div class="dialog-overlay" id="resizeDialog">
    <div class="dialog-box">
        <div class="dialog-title">Resize Texture</div>
        <div class="dialog-row">
            <label>Width:</label>
            <select id="resizeW">
                <option value="32">32</option>
                <option value="64">64</option>
                <option value="128">128</option>
                <option value="256" selected>256</option>
                <option value="512">512</option>
                <option value="1024">1024</option>
            </select>
        </div>
        <div class="dialog-row">
            <label>Height:</label>
            <select id="resizeH">
                <option value="32">32</option>
                <option value="64">64</option>
                <option value="128">128</option>
                <option value="256" selected>256</option>
                <option value="512">512</option>
                <option value="1024">1024</option>
            </select>
        </div>
        <div class="dialog-actions">
            <button class="adj-btn secondary" id="resizeCancel">Cancel</button>
            <button class="adj-btn" id="resizeOk">Resize</button>
        </div>
    </div>
</div>

<script>
const vscode = acquireVsCodeApi();

// ─── State ───────────────────────────────────────────────────────────────
let imageWidth = 0, imageHeight = 0;
let zoom = 1, panX = 0, panY = 0;
let isDragging = false, lastMX = 0, lastMY = 0;
let cropMode = false, cropStart = null, cropEnd = null, isCropping = false;

// Offscreen canvas holds the actual pixel data
const offscreen = document.createElement('canvas');
const offCtx = offscreen.getContext('2d');

// Committed pixels (before adjustment sliders)
let committedImageData = null;

// DOM refs
const container = document.getElementById('canvasContainer');
const mainCanvas = document.getElementById('mainCanvas');
const mainCtx = mainCanvas.getContext('2d');
const overlayCanvas = document.getElementById('overlayCanvas');
const overlayCtx = overlayCanvas.getContext('2d');
const checker = document.getElementById('checkerboard');

const infoBadge = document.getElementById('infoBadge');
const infoDims = document.getElementById('infoDims');
const infoMips = document.getElementById('infoMips');
const infoSize = document.getElementById('infoSize');
const infoZoom = document.getElementById('infoZoom');

const sliders = {
    brightness: document.getElementById('slBrightness'),
    contrast: document.getElementById('slContrast'),
    saturation: document.getElementById('slSaturation'),
    hue: document.getElementById('slHue')
};

const valLabels = {
    brightness: document.getElementById('valBrightness'),
    contrast: document.getElementById('valContrast'),
    saturation: document.getElementById('valSaturation'),
    hue: document.getElementById('valHue')
};

// ─── Helpers ─────────────────────────────────────────────────────────────
function clampByte(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }

function base64ToUint8Array(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) { arr[i] = bin.charCodeAt(i); }
    return arr;
}

function imageDataToBase64(imgData) {
    const arr = new Uint8Array(imgData.data.buffer, imgData.data.byteOffset, imgData.data.byteLength);
    let binary = '';
    for (let i = 0; i < arr.length; i++) { binary += String.fromCharCode(arr[i]); }
    return btoa(binary);
}

function loadRGBAToOffscreen(rgba, w, h) {
    imageWidth = w;
    imageHeight = h;
    offscreen.width = w;
    offscreen.height = h;
    const imgData = new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), w, h);
    offCtx.putImageData(imgData, 0, 0);
    committedImageData = offCtx.getImageData(0, 0, w, h);
}

// ─── Render ──────────────────────────────────────────────────────────────
function render() {
    const cw = container.clientWidth;
    const ch = container.clientHeight;

    const displayW = Math.round(imageWidth * zoom);
    const displayH = Math.round(imageHeight * zoom);

    // Center the image with pan offset
    const ox = Math.round((cw - displayW) / 2 + panX);
    const oy = Math.round((ch - displayH) / 2 + panY);

    // Position checkerboard
    checker.style.left = ox + 'px';
    checker.style.top = oy + 'px';
    checker.style.width = displayW + 'px';
    checker.style.height = displayH + 'px';

    // Main canvas
    mainCanvas.width = displayW;
    mainCanvas.height = displayH;
    mainCanvas.style.left = ox + 'px';
    mainCanvas.style.top = oy + 'px';
    mainCtx.imageSmoothingEnabled = zoom < 1;
    mainCtx.drawImage(offscreen, 0, 0, displayW, displayH);

    // Overlay canvas (for crop rectangle)
    overlayCanvas.width = cw;
    overlayCanvas.height = ch;
    overlayCanvas.style.left = '0';
    overlayCanvas.style.top = '0';

    if (cropMode && cropStart && cropEnd) {
        drawCropOverlay(ox, oy, displayW, displayH);
    }

    infoZoom.textContent = Math.round(zoom * 100) + '%';
}

function drawCropOverlay(ox, oy, dw, dh) {
    // Convert image coords to screen coords
    const sx1 = ox + Math.min(cropStart.x, cropEnd.x) * zoom;
    const sy1 = oy + Math.min(cropStart.y, cropEnd.y) * zoom;
    const sx2 = ox + Math.max(cropStart.x, cropEnd.x) * zoom;
    const sy2 = oy + Math.max(cropStart.y, cropEnd.y) * zoom;

    const cw = overlayCanvas.width;
    const ch = overlayCanvas.height;

    overlayCtx.clearRect(0, 0, cw, ch);

    // Darken outside selection
    overlayCtx.fillStyle = 'rgba(0,0,0,0.5)';
    overlayCtx.fillRect(0, 0, cw, ch);
    overlayCtx.clearRect(sx1, sy1, sx2 - sx1, sy2 - sy1);

    // Selection border
    overlayCtx.strokeStyle = '#fff';
    overlayCtx.lineWidth = 1;
    overlayCtx.setLineDash([4, 4]);
    overlayCtx.strokeRect(sx1, sy1, sx2 - sx1, sy2 - sy1);
    overlayCtx.setLineDash([]);

    // Update crop info
    const cw2 = Math.round(Math.abs(cropEnd.x - cropStart.x));
    const ch2 = Math.round(Math.abs(cropEnd.y - cropStart.y));
    document.getElementById('cropInfo').textContent = cw2 + ' x ' + ch2;
}

function fitToView() {
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (imageWidth === 0 || imageHeight === 0) { return; }
    zoom = Math.min((cw - 20) / imageWidth, (ch - 20) / imageHeight, 4);
    panX = 0;
    panY = 0;
    render();
}

// ─── Mouse: Pan/Zoom ─────────────────────────────────────────────────────
function screenToImage(mx, my) {
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const ox = (cw - imageWidth * zoom) / 2 + panX;
    const oy = (ch - imageHeight * zoom) / 2 + panY;
    return {
        x: (mx - ox) / zoom,
        y: (my - oy) / zoom
    };
}

container.addEventListener('wheel', function(e) {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(0.1, Math.min(32, zoom * factor));

    // Zoom toward mouse position
    const rect = container.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const cw = container.clientWidth;
    const ch = container.clientHeight;

    const imgCX = (cw / 2 + panX);
    const imgCY = (ch / 2 + panY);

    panX = panX + (mx - imgCX) * (1 - newZoom / zoom);
    panY = panY + (my - imgCY) * (1 - newZoom / zoom);
    zoom = newZoom;
    render();
}, { passive: false });

container.addEventListener('mousedown', function(e) {
    if (e.button !== 0) { return; }
    const rect = container.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (cropMode) {
        const img = screenToImage(mx, my);
        cropStart = { x: clampCoord(img.x, imageWidth), y: clampCoord(img.y, imageHeight) };
        cropEnd = { x: cropStart.x, y: cropStart.y };
        isCropping = true;
        document.getElementById('cropBar').classList.add('visible');
        return;
    }

    isDragging = true;
    lastMX = e.clientX;
    lastMY = e.clientY;
    container.classList.add('dragging');
});

window.addEventListener('mousemove', function(e) {
    if (isCropping) {
        const rect = container.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const img = screenToImage(mx, my);
        cropEnd = { x: clampCoord(img.x, imageWidth), y: clampCoord(img.y, imageHeight) };
        render();
        return;
    }
    if (!isDragging) { return; }
    panX += e.clientX - lastMX;
    panY += e.clientY - lastMY;
    lastMX = e.clientX;
    lastMY = e.clientY;
    render();
});

window.addEventListener('mouseup', function() {
    isDragging = false;
    isCropping = false;
    container.classList.remove('dragging');
});

function clampCoord(v, max) { return Math.max(0, Math.min(max, Math.round(v))); }

// ─── Toolbar Actions ─────────────────────────────────────────────────────
function commitEdit() {
    const imgData = offCtx.getImageData(0, 0, offscreen.width, offscreen.height);
    const b64 = imageDataToBase64(imgData);
    vscode.postMessage({ type: 'edit', width: offscreen.width, height: offscreen.height, rgbaBase64: b64 });
    committedImageData = offCtx.getImageData(0, 0, offscreen.width, offscreen.height);
    imageWidth = offscreen.width;
    imageHeight = offscreen.height;
    updateInfoDims();
}

function updateInfoDims() {
    infoDims.textContent = imageWidth + ' x ' + imageHeight;
}

// Flip Horizontal
document.getElementById('btnFlipH').addEventListener('click', function() {
    const w = offscreen.width, h = offscreen.height;
    const imgData = offCtx.getImageData(0, 0, w, h);
    const d = imgData.data;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < Math.floor(w / 2); x++) {
            const i1 = (y * w + x) * 4;
            const i2 = (y * w + (w - 1 - x)) * 4;
            for (let c = 0; c < 4; c++) {
                const tmp = d[i1 + c]; d[i1 + c] = d[i2 + c]; d[i2 + c] = tmp;
            }
        }
    }
    offCtx.putImageData(imgData, 0, 0);
    render();
    commitEdit();
});

// Flip Vertical
document.getElementById('btnFlipV').addEventListener('click', function() {
    const w = offscreen.width, h = offscreen.height;
    const imgData = offCtx.getImageData(0, 0, w, h);
    const d = imgData.data;
    for (let y = 0; y < Math.floor(h / 2); y++) {
        for (let x = 0; x < w; x++) {
            const i1 = (y * w + x) * 4;
            const i2 = ((h - 1 - y) * w + x) * 4;
            for (let c = 0; c < 4; c++) {
                const tmp = d[i1 + c]; d[i1 + c] = d[i2 + c]; d[i2 + c] = tmp;
            }
        }
    }
    offCtx.putImageData(imgData, 0, 0);
    render();
    commitEdit();
});

// Rotate 90 CW
document.getElementById('btnRotCW').addEventListener('click', function() {
    const w = offscreen.width, h = offscreen.height;
    const src = offCtx.getImageData(0, 0, w, h);
    offscreen.width = h;
    offscreen.height = w;
    const dst = offCtx.createImageData(h, w);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const si = (y * w + x) * 4;
            const di = (x * h + (h - 1 - y)) * 4;
            dst.data[di] = src.data[si];
            dst.data[di + 1] = src.data[si + 1];
            dst.data[di + 2] = src.data[si + 2];
            dst.data[di + 3] = src.data[si + 3];
        }
    }
    offCtx.putImageData(dst, 0, 0);
    render();
    commitEdit();
});

// Rotate 90 CCW
document.getElementById('btnRotCCW').addEventListener('click', function() {
    const w = offscreen.width, h = offscreen.height;
    const src = offCtx.getImageData(0, 0, w, h);
    offscreen.width = h;
    offscreen.height = w;
    const dst = offCtx.createImageData(h, w);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const si = (y * w + x) * 4;
            const di = ((w - 1 - x) * h + y) * 4;
            dst.data[di] = src.data[si];
            dst.data[di + 1] = src.data[si + 1];
            dst.data[di + 2] = src.data[si + 2];
            dst.data[di + 3] = src.data[si + 3];
        }
    }
    offCtx.putImageData(dst, 0, 0);
    render();
    commitEdit();
});

// Rotate 180
document.getElementById('btnRot180').addEventListener('click', function() {
    const w = offscreen.width, h = offscreen.height;
    const imgData = offCtx.getImageData(0, 0, w, h);
    const d = imgData.data;
    const total = w * h;
    for (let i = 0; i < Math.floor(total / 2); i++) {
        const j = total - 1 - i;
        const i4 = i * 4, j4 = j * 4;
        for (let c = 0; c < 4; c++) {
            const tmp = d[i4 + c]; d[i4 + c] = d[j4 + c]; d[j4 + c] = tmp;
        }
    }
    offCtx.putImageData(imgData, 0, 0);
    render();
    commitEdit();
});

// Fit to View
document.getElementById('btnFitView').addEventListener('click', fitToView);

// Actual Size
document.getElementById('btnActualSize').addEventListener('click', function() {
    zoom = 1;
    panX = 0;
    panY = 0;
    render();
});

// ─── Crop ────────────────────────────────────────────────────────────────
document.getElementById('btnCrop').addEventListener('click', function() {
    cropMode = !cropMode;
    this.classList.toggle('active', cropMode);
    container.classList.toggle('crop-mode', cropMode);
    if (!cropMode) {
        cropStart = null;
        cropEnd = null;
        document.getElementById('cropBar').classList.remove('visible');
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }
});

document.getElementById('cropApply').addEventListener('click', function() {
    if (!cropStart || !cropEnd) { return; }
    const x1 = Math.min(cropStart.x, cropEnd.x);
    const y1 = Math.min(cropStart.y, cropEnd.y);
    const x2 = Math.max(cropStart.x, cropEnd.x);
    const y2 = Math.max(cropStart.y, cropEnd.y);
    const cw = x2 - x1;
    const ch = y2 - y1;
    if (cw < 1 || ch < 1) { return; }

    const src = offCtx.getImageData(x1, y1, cw, ch);
    offscreen.width = cw;
    offscreen.height = ch;
    offCtx.putImageData(src, 0, 0);

    cropMode = false;
    cropStart = null;
    cropEnd = null;
    document.getElementById('btnCrop').classList.remove('active');
    container.classList.remove('crop-mode');
    document.getElementById('cropBar').classList.remove('visible');
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    render();
    commitEdit();
});

document.getElementById('cropCancel').addEventListener('click', function() {
    cropStart = null;
    cropEnd = null;
    document.getElementById('cropBar').classList.remove('visible');
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    render();
});

// ─── Resize Dialog ───────────────────────────────────────────────────────
document.getElementById('btnResize').addEventListener('click', function() {
    document.getElementById('resizeW').value = String(imageWidth);
    document.getElementById('resizeH').value = String(imageHeight);
    document.getElementById('resizeDialog').classList.add('visible');
});

document.getElementById('resizeCancel').addEventListener('click', function() {
    document.getElementById('resizeDialog').classList.remove('visible');
});

document.getElementById('resizeOk').addEventListener('click', function() {
    const newW = parseInt(document.getElementById('resizeW').value);
    const newH = parseInt(document.getElementById('resizeH').value);
    document.getElementById('resizeDialog').classList.remove('visible');
    if (newW === imageWidth && newH === imageHeight) { return; }

    // Bilinear resize
    const src = offCtx.getImageData(0, 0, offscreen.width, offscreen.height);
    offscreen.width = newW;
    offscreen.height = newH;
    const dst = offCtx.createImageData(newW, newH);
    const sd = src.data, dd = dst.data;
    const sw = src.width, sh = src.height;

    for (let dy = 0; dy < newH; dy++) {
        const sy = dy * (sh - 1) / Math.max(1, newH - 1);
        const sy0 = Math.floor(sy);
        const sy1 = Math.min(sy0 + 1, sh - 1);
        const fy = sy - sy0;

        for (let dx = 0; dx < newW; dx++) {
            const sx = dx * (sw - 1) / Math.max(1, newW - 1);
            const sx0 = Math.floor(sx);
            const sx1 = Math.min(sx0 + 1, sw - 1);
            const fx = sx - sx0;

            const i00 = (sy0 * sw + sx0) * 4;
            const i10 = (sy0 * sw + sx1) * 4;
            const i01 = (sy1 * sw + sx0) * 4;
            const i11 = (sy1 * sw + sx1) * 4;
            const di = (dy * newW + dx) * 4;

            for (let c = 0; c < 4; c++) {
                const top = sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx;
                const bot = sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx;
                dd[di + c] = Math.round(top * (1 - fy) + bot * fy);
            }
        }
    }

    offCtx.putImageData(dst, 0, 0);
    render();
    commitEdit();
});

// ─── Adjustments ─────────────────────────────────────────────────────────
function getSliderValues() {
    return {
        brightness: parseInt(sliders.brightness.value),
        contrast: parseInt(sliders.contrast.value),
        saturation: parseInt(sliders.saturation.value),
        hue: parseInt(sliders.hue.value)
    };
}

function slidersAreZero() {
    const v = getSliderValues();
    return v.brightness === 0 && v.contrast === 0 && v.saturation === 0 && v.hue === 0;
}

function applyAdjustments(preview) {
    if (!committedImageData) { return; }
    const v = getSliderValues();

    // Update labels
    valLabels.brightness.textContent = v.brightness;
    valLabels.contrast.textContent = v.contrast;
    valLabels.saturation.textContent = v.saturation;
    valLabels.hue.textContent = v.hue;

    if (slidersAreZero() && preview) {
        offCtx.putImageData(committedImageData, 0, 0);
        render();
        return;
    }

    // Work on a copy of committed pixels
    const src = committedImageData.data;
    const dst = new ImageData(new Uint8ClampedArray(src), committedImageData.width, committedImageData.height);
    const d = dst.data;

    // Brightness
    const bright = v.brightness * 2.55; // map -100..100 to -255..255

    // Contrast factor
    const contrastVal = v.contrast * 2.55;
    const cf = (259 * (contrastVal + 255)) / (255 * (259 - contrastVal));

    // Saturation factor
    const sf = 1 + v.saturation / 100;

    // Hue shift
    const hueRad = v.hue * Math.PI / 180;
    const doHue = v.hue !== 0;

    for (let i = 0; i < d.length; i += 4) {
        let r = d[i], g = d[i + 1], b = d[i + 2];

        // Brightness
        if (v.brightness !== 0) {
            r += bright;
            g += bright;
            b += bright;
        }

        // Contrast
        if (v.contrast !== 0) {
            r = cf * (r - 128) + 128;
            g = cf * (g - 128) + 128;
            b = cf * (b - 128) + 128;
        }

        // Saturation
        if (v.saturation !== 0) {
            const gray = 0.299 * r + 0.587 * g + 0.114 * b;
            r = gray + sf * (r - gray);
            g = gray + sf * (g - gray);
            b = gray + sf * (b - gray);
        }

        // Hue shift via rotation in YIQ-like space
        if (doHue) {
            const cosH = Math.cos(hueRad);
            const sinH = Math.sin(hueRad);
            const nr = r * (0.299 + 0.701 * cosH + 0.168 * sinH)
                     + g * (0.587 - 0.587 * cosH + 0.330 * sinH)
                     + b * (0.114 - 0.114 * cosH - 0.497 * sinH);
            const ng = r * (0.299 - 0.299 * cosH - 0.328 * sinH)
                     + g * (0.587 + 0.413 * cosH + 0.035 * sinH)
                     + b * (0.114 - 0.114 * cosH + 0.292 * sinH);
            const nb = r * (0.299 - 0.300 * cosH + 1.250 * sinH)
                     + g * (0.587 - 0.588 * cosH - 1.050 * sinH)
                     + b * (0.114 + 0.886 * cosH - 0.203 * sinH);
            r = nr; g = ng; b = nb;
        }

        d[i] = clampByte(r);
        d[i + 1] = clampByte(g);
        d[i + 2] = clampByte(b);
        // alpha unchanged
    }

    offCtx.putImageData(dst, 0, 0);
    render();

    if (!preview) {
        commitEdit();
        resetSliders();
    }
}

function resetSliders() {
    sliders.brightness.value = 0;
    sliders.contrast.value = 0;
    sliders.saturation.value = 0;
    sliders.hue.value = 0;
    valLabels.brightness.textContent = '0';
    valLabels.contrast.textContent = '0';
    valLabels.saturation.textContent = '0';
    valLabels.hue.textContent = '0';
}

// Live preview on slider input
Object.keys(sliders).forEach(function(key) {
    sliders[key].addEventListener('input', function() {
        applyAdjustments(true);
    });
});

// Apply button
document.getElementById('btnAdjApply').addEventListener('click', function() {
    if (slidersAreZero()) { return; }
    applyAdjustments(false);
});

// Reset button
document.getElementById('btnAdjReset').addEventListener('click', function() {
    resetSliders();
    if (committedImageData) {
        offCtx.putImageData(committedImageData, 0, 0);
        render();
    }
});

// ─── Keyboard Shortcuts ──────────────────────────────────────────────────
document.addEventListener('keydown', function(e) {
    if (e.key === 'f' || e.key === 'F') { fitToView(); }
    if (e.key === '1') { zoom = 1; panX = 0; panY = 0; render(); }
    if (e.key === '2') { zoom = 2; panX = 0; panY = 0; render(); }
    if (e.key === '4') { zoom = 4; panX = 0; panY = 0; render(); }
    if (e.key === 'c' || e.key === 'C') {
        if (!e.ctrlKey && !e.metaKey) {
            document.getElementById('btnCrop').click();
        }
    }
    if (e.key === 'Escape') {
        if (cropMode) {
            document.getElementById('cropCancel').click();
            cropMode = false;
            document.getElementById('btnCrop').classList.remove('active');
            container.classList.remove('crop-mode');
        }
    }
    if (e.key === 'Enter' && cropMode && cropStart && cropEnd) {
        document.getElementById('cropApply').click();
    }
});

// ─── Message Handling ────────────────────────────────────────────────────
window.addEventListener('message', function(e) {
    const msg = e.data;
    switch (msg.type) {
        case 'load': {
            document.getElementById('errorOverlay').classList.remove('visible');
            const rgba = base64ToUint8Array(msg.rgbaBase64);
            loadRGBAToOffscreen(rgba, msg.width, msg.height);
            infoBadge.textContent = msg.fourCC;
            infoDims.textContent = msg.width + ' x ' + msg.height;
            infoMips.textContent = msg.mipCount + ' mips';
            infoSize.textContent = Math.round(msg.fileSize / 1024) + ' KB';
            resetSliders();
            fitToView();
            break;
        }
        case 'updatePixels': {
            const rgba = base64ToUint8Array(msg.rgbaBase64);
            loadRGBAToOffscreen(rgba, msg.width, msg.height);
            resetSliders();
            render();
            break;
        }
        case 'error': {
            document.getElementById('errorOverlay').classList.add('visible');
            document.getElementById('errorDetail').textContent = msg.message;
            document.getElementById('errorFilename').textContent = msg.fileName;
            infoBadge.textContent = '???';
            infoDims.textContent = 'Error';
            infoMips.textContent = '';
            infoSize.textContent = Math.round(msg.fileSize / 1024) + ' KB';
            break;
        }
    }
});

// ─── Window Resize ───────────────────────────────────────────────────────
window.addEventListener('resize', function() { render(); });

// ─── Init ────────────────────────────────────────────────────────────────
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }
}
