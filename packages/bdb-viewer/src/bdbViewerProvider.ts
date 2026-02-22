import * as vscode from 'vscode';
import * as path from 'path';
import { getDbStats, getRecordPage, formatOID, oidTableId, DbStats, RawRecord } from './bdbAccess';
import { parseRecordSummary, parseRecordDetail } from './fieldParser';

const PAGE_SIZE = 50;
const LOG = vscode.window.createOutputChannel('BDB Viewer');

class BDBDocument implements vscode.CustomDocument {
    public stats: DbStats | null = null;
    public currentPageRecords: RawRecord[] = [];

    constructor(public readonly uri: vscode.Uri) {}
    public dispose(): void {}
}

export class BDBViewerProvider implements vscode.CustomReadonlyEditorProvider<BDBDocument> {
    public static readonly viewType = 'bdbViewer.bdbFile';

    constructor(private readonly context: vscode.ExtensionContext) {}

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new BDBViewerProvider(context);
        return vscode.window.registerCustomEditorProvider(
            BDBViewerProvider.viewType,
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
    ): Promise<BDBDocument> {
        LOG.appendLine('[openCustomDocument] ' + uri.fsPath);
        return new BDBDocument(uri);
    }

    async resolveCustomEditor(
        document: BDBDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        LOG.appendLine('[resolveCustomEditor] Setting up webview for ' + document.uri.fsPath);
        webviewPanel.webview.options = { enableScripts: true };

        // Set up message handler BEFORE setting HTML (to avoid race)
        webviewPanel.webview.onDidReceiveMessage(async (msg) => {
            LOG.appendLine('[webview->ext] ' + msg.type);
            try {
                switch (msg.type) {
                    case 'ready':
                        await this.handleReady(document, webviewPanel);
                        break;
                    case 'getPage':
                        await this.handleGetPage(document, webviewPanel, msg.page);
                        break;
                    case 'getRecord':
                        await this.handleGetRecord(document, webviewPanel, msg.pageIndex);
                        break;
                }
            } catch (err: any) {
                LOG.appendLine('[ERROR] Unhandled in message handler: ' + err.message);
                LOG.appendLine(err.stack || '');
                try {
                    webviewPanel.webview.postMessage({
                        type: 'error',
                        message: 'Internal error: ' + err.message
                    });
                } catch {}
            }
        });

        // Set HTML after handler is registered
        webviewPanel.webview.html = this.getHtml();
        LOG.appendLine('[resolveCustomEditor] HTML set, waiting for ready message');
    }

    private async handleReady(document: BDBDocument, panel: vscode.WebviewPanel): Promise<void> {
        const fileName = path.basename(document.uri.fsPath);
        LOG.appendLine('[handleReady] ' + fileName + ' at ' + document.uri.fsPath);
        try {
            document.stats = await getDbStats(document.uri.fsPath);
            LOG.appendLine('[handleReady] stats: ' + JSON.stringify(document.stats));
            const totalPages = Math.max(1, Math.ceil(document.stats.recordCount / PAGE_SIZE));
            panel.webview.postMessage({
                type: 'metadata',
                fileName,
                recordCount: document.stats.recordCount,
                dbType: document.stats.dbType,
                pageSize: document.stats.pageSize,
                totalPages
            });
            LOG.appendLine('[handleReady] metadata sent, loading page 0');
            await this.handleGetPage(document, panel, 0);
        } catch (err: any) {
            LOG.appendLine('[handleReady] ERROR: ' + err.message);
            LOG.appendLine(err.stack || '');
            panel.webview.postMessage({
                type: 'error',
                message: 'Failed to read database: ' + err.message
            });
        }
    }

    private async handleGetPage(document: BDBDocument, panel: vscode.WebviewPanel, page: number): Promise<void> {
        LOG.appendLine('[handleGetPage] page=' + page);
        panel.webview.postMessage({ type: 'loading', page });

        try {
            const rawRecords = await getRecordPage(document.uri.fsPath, page, PAGE_SIZE);
            LOG.appendLine('[handleGetPage] got ' + rawRecords.length + ' raw records');
            document.currentPageRecords = rawRecords;

            const records = rawRecords.map((r, i) => {
                try {
                    const summary = parseRecordSummary(r.valueHex);
                    return {
                        pageIndex: i,
                        oid: formatOID(r.oid),
                        tableId: oidTableId(r.oid),
                        className: summary.className,
                        fieldCount: summary.fieldCount,
                        compressedSize: summary.compressedSize,
                        decompressedSize: summary.decompressedSize
                    };
                } catch (e: any) {
                    LOG.appendLine('[handleGetPage] parse error for record ' + i + ': ' + e.message);
                    return {
                        pageIndex: i,
                        oid: formatOID(r.oid),
                        tableId: oidTableId(r.oid),
                        className: '[error]',
                        fieldCount: 0,
                        compressedSize: r.valueHex.length / 2,
                        decompressedSize: 0
                    };
                }
            });

            const totalPages = document.stats
                ? Math.max(1, Math.ceil(document.stats.recordCount / PAGE_SIZE))
                : 1;

            LOG.appendLine('[handleGetPage] sending page with ' + records.length + ' records, totalPages=' + totalPages);
            panel.webview.postMessage({
                type: 'page',
                records,
                pageNum: page,
                totalPages
            });
        } catch (err: any) {
            LOG.appendLine('[handleGetPage] ERROR: ' + err.message);
            panel.webview.postMessage({
                type: 'error',
                message: 'Failed to read page ' + page + ': ' + err.message
            });
        }
    }

    private async handleGetRecord(document: BDBDocument, panel: vscode.WebviewPanel, pageIndex: number): Promise<void> {
        if (pageIndex < 0 || pageIndex >= document.currentPageRecords.length) {
            LOG.appendLine('[handleGetRecord] index out of range: ' + pageIndex);
            return;
        }

        try {
            const raw = document.currentPageRecords[pageIndex];
            const detail = parseRecordDetail(raw.valueHex);

            const fields = detail.fields.map(f => ({
                name: f.name,
                type: f.type,
                decoded: f.decoded,
                size: f.size,
                hash: '0x' + f.hash.toString(16).toUpperCase().padStart(8, '0')
            }));

            panel.webview.postMessage({
                type: 'recordDetail',
                pageIndex,
                oid: formatOID(raw.oid),
                className: detail.className,
                decompressedSize: detail.decompressedSize,
                fields
            });
        } catch (err: any) {
            LOG.appendLine('[handleGetRecord] ERROR: ' + err.message);
            panel.webview.postMessage({
                type: 'error',
                message: 'Failed to parse record: ' + err.message
            });
        }
    }

    private getHtml(): string {
        var lines: string[] = [];
        lines.push('<!DOCTYPE html>');
        lines.push('<html lang="en">');
        lines.push('<head>');
        lines.push('<meta charset="UTF-8">');
        lines.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
        lines.push('<title>BDB Viewer</title>');
        lines.push('<style>');
        lines.push('* { box-sizing: border-box; margin: 0; padding: 0; }');
        lines.push('body {');
        lines.push('  font-family: var(--vscode-font-family);');
        lines.push('  font-size: var(--vscode-font-size);');
        lines.push('  color: var(--vscode-foreground);');
        lines.push('  background: var(--vscode-editor-background);');
        lines.push('  padding: 10px;');
        lines.push('}');
        lines.push('.header {');
        lines.push('  display: flex; align-items: center; gap: 16px; padding: 8px 12px;');
        lines.push('  background: var(--vscode-toolbar-background); border-radius: 4px;');
        lines.push('  margin-bottom: 8px; flex-wrap: wrap;');
        lines.push('}');
        lines.push('.header .filename { font-weight: 600; font-size: 14px; }');
        lines.push('.header .badge {');
        lines.push('  padding: 2px 8px; border-radius: 10px; font-size: 11px;');
        lines.push('  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);');
        lines.push('}');
        lines.push('.pagination {');
        lines.push('  display: flex; align-items: center; gap: 4px; padding: 6px 0;');
        lines.push('  margin-bottom: 8px;');
        lines.push('}');
        lines.push('.pagination button {');
        lines.push('  padding: 4px 10px; background: var(--vscode-button-background);');
        lines.push('  color: var(--vscode-button-foreground); border: none; border-radius: 3px;');
        lines.push('  cursor: pointer; font-size: 12px;');
        lines.push('}');
        lines.push('.pagination button:hover { background: var(--vscode-button-hoverBackground); }');
        lines.push('.pagination button:disabled { opacity: 0.4; cursor: not-allowed; }');
        lines.push('.pagination .page-info {');
        lines.push('  padding: 0 8px; font-size: 12px; color: var(--vscode-descriptionForeground);');
        lines.push('}');
        lines.push('.pagination .jump-input {');
        lines.push('  width: 60px; padding: 3px 6px; background: var(--vscode-input-background);');
        lines.push('  color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border);');
        lines.push('  border-radius: 3px; font-size: 12px; text-align: center;');
        lines.push('}');
        lines.push('.table-container {');
        lines.push('  overflow: auto; max-height: calc(100vh - 140px);');
        lines.push('  border: 1px solid var(--vscode-panel-border); border-radius: 4px;');
        lines.push('}');
        lines.push('table { width: 100%; border-collapse: collapse; }');
        lines.push('th {');
        lines.push('  position: sticky; top: 0; background: var(--vscode-editor-background);');
        lines.push('  padding: 8px 10px; text-align: left; font-weight: 600; font-size: 12px;');
        lines.push('  border-bottom: 2px solid var(--vscode-panel-border); z-index: 2;');
        lines.push('  white-space: nowrap;');
        lines.push('}');
        lines.push('td {');
        lines.push('  padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border);');
        lines.push('  font-family: var(--vscode-editor-font-family); font-size: 12px;');
        lines.push('  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;');
        lines.push('}');
        lines.push('tr.data-row { cursor: pointer; }');
        lines.push('tr.data-row:hover td { background: var(--vscode-list-hoverBackground); }');
        lines.push('tr.data-row.selected td { background: var(--vscode-list-activeSelectionBackground); }');
        lines.push('.col-idx { width: 50px; text-align: right; color: var(--vscode-editorLineNumber-foreground); }');
        lines.push('.col-oid { width: 180px; font-family: var(--vscode-editor-font-family); }');
        lines.push('.col-class { width: 200px; }');
        lines.push('.col-fields { width: 60px; text-align: right; }');
        lines.push('.col-size { width: 100px; text-align: right; color: var(--vscode-descriptionForeground); }');
        lines.push('.detail-row td { padding: 0; background: var(--vscode-editor-background); }');
        lines.push('.detail-panel {');
        lines.push('  padding: 12px 16px; border-left: 3px solid var(--vscode-focusBorder);');
        lines.push('  margin: 4px 0;');
        lines.push('}');
        lines.push('.detail-header {');
        lines.push('  font-weight: 600; margin-bottom: 8px; font-size: 13px;');
        lines.push('  display: flex; align-items: center; gap: 12px;');
        lines.push('}');
        lines.push('.detail-header .badge { font-size: 10px; font-weight: normal; }');
        lines.push('.field-table { width: 100%; border-collapse: collapse; }');
        lines.push('.field-table th {');
        lines.push('  position: static; padding: 4px 8px; font-size: 11px; text-align: left;');
        lines.push('  background: var(--vscode-toolbar-background); border-bottom: 1px solid var(--vscode-panel-border);');
        lines.push('}');
        lines.push('.field-table td {');
        lines.push('  padding: 3px 8px; font-size: 11px; border-bottom: 1px solid var(--vscode-panel-border);');
        lines.push('  white-space: normal; word-break: break-all;');
        lines.push('}');
        lines.push('.field-table .fname { width: 250px; font-weight: 500; }');
        lines.push('.field-table .ftype { width: 180px; color: var(--vscode-descriptionForeground); }');
        lines.push('.field-table .fsize { width: 60px; text-align: right; color: var(--vscode-descriptionForeground); }');
        lines.push('.field-table .fval { font-family: var(--vscode-editor-font-family); }');
        lines.push('.field-unknown { color: var(--vscode-descriptionForeground); font-style: italic; }');
        lines.push('.loading { padding: 20px; text-align: center; color: var(--vscode-descriptionForeground); }');
        lines.push('.error-msg {');
        lines.push('  padding: 12px; background: var(--vscode-inputValidation-errorBackground);');
        lines.push('  color: var(--vscode-inputValidation-errorForeground); border-radius: 4px;');
        lines.push('  margin-bottom: 8px; display: none;');
        lines.push('}');
        lines.push('.error-msg.visible { display: block; }');
        lines.push('.empty-msg { padding: 40px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 14px; }');
        lines.push('</style>');
        lines.push('</head>');
        lines.push('<body>');
        lines.push('<div class="header">');
        lines.push('  <span class="filename" id="dbName">Loading...</span>');
        lines.push('  <span class="badge" id="dbRecords"></span>');
        lines.push('  <span class="badge" id="dbType"></span>');
        lines.push('</div>');
        lines.push('<div class="error-msg" id="errorMsg"></div>');
        lines.push('<div class="pagination" id="paginationBar">');
        lines.push('  <button id="btnFirst" title="First page">&laquo;</button>');
        lines.push('  <button id="btnPrev" title="Previous page">&lsaquo;</button>');
        lines.push('  <span class="page-info" id="pageInfo">-</span>');
        lines.push('  <button id="btnNext" title="Next page">&rsaquo;</button>');
        lines.push('  <button id="btnLast" title="Last page">&raquo;</button>');
        lines.push('  <input type="number" class="jump-input" id="jumpInput" min="1" placeholder="#" title="Jump to page">');
        lines.push('  <button id="btnJump">Go</button>');
        lines.push('</div>');
        lines.push('<div class="table-container">');
        lines.push('  <table>');
        lines.push('    <thead><tr>');
        lines.push('      <th class="col-idx">#</th>');
        lines.push('      <th class="col-oid">OID</th>');
        lines.push('      <th class="col-class">Class</th>');
        lines.push('      <th class="col-fields">Fields</th>');
        lines.push('      <th class="col-size">Size</th>');
        lines.push('    </tr></thead>');
        lines.push('    <tbody id="tableBody"></tbody>');
        lines.push('  </table>');
        lines.push('</div>');
        lines.push('<script>');
        // Use a self-executing function to avoid any global scope issues
        lines.push('(function() {');
        lines.push('var vscodeApi = acquireVsCodeApi();');
        lines.push('var currentPage = 0;');
        lines.push('var totalPages = 1;');
        lines.push('var expandedIdx = -1;');
        lines.push('');
        lines.push('var tableBody = document.getElementById("tableBody");');
        lines.push('var pageInfo = document.getElementById("pageInfo");');
        lines.push('var btnFirst = document.getElementById("btnFirst");');
        lines.push('var btnPrev = document.getElementById("btnPrev");');
        lines.push('var btnNext = document.getElementById("btnNext");');
        lines.push('var btnLast = document.getElementById("btnLast");');
        lines.push('var btnJump = document.getElementById("btnJump");');
        lines.push('var jumpInput = document.getElementById("jumpInput");');
        lines.push('var errorMsg = document.getElementById("errorMsg");');
        lines.push('');
        lines.push('btnFirst.addEventListener("click", function() { goToPage(0); });');
        lines.push('btnPrev.addEventListener("click", function() { goToPage(currentPage - 1); });');
        lines.push('btnNext.addEventListener("click", function() { goToPage(currentPage + 1); });');
        lines.push('btnLast.addEventListener("click", function() { goToPage(totalPages - 1); });');
        lines.push('btnJump.addEventListener("click", function() {');
        lines.push('  var p = parseInt(jumpInput.value, 10);');
        lines.push('  if (p >= 1 && p <= totalPages) { goToPage(p - 1); }');
        lines.push('});');
        lines.push('jumpInput.addEventListener("keydown", function(e) {');
        lines.push('  if (e.key === "Enter") { btnJump.click(); }');
        lines.push('});');
        lines.push('');
        lines.push('function goToPage(page) {');
        lines.push('  if (page < 0 || page >= totalPages) return;');
        lines.push('  currentPage = page;');
        lines.push('  expandedIdx = -1;');
        lines.push('  vscodeApi.postMessage({ type: "getPage", page: page });');
        lines.push('}');
        lines.push('');
        lines.push('function updatePagination() {');
        lines.push('  pageInfo.textContent = "Page " + (currentPage + 1) + " of " + totalPages;');
        lines.push('  btnFirst.disabled = currentPage === 0;');
        lines.push('  btnPrev.disabled = currentPage === 0;');
        lines.push('  btnNext.disabled = currentPage >= totalPages - 1;');
        lines.push('  btnLast.disabled = currentPage >= totalPages - 1;');
        lines.push('  jumpInput.max = totalPages;');
        lines.push('}');
        lines.push('');
        lines.push('function showError(msg) {');
        lines.push('  errorMsg.textContent = msg;');
        lines.push('  errorMsg.classList.add("visible");');
        lines.push('}');
        lines.push('');
        lines.push('function hideError() { errorMsg.classList.remove("visible"); }');
        lines.push('');
        lines.push('function esc(str) {');
        lines.push('  var d = document.createElement("div");');
        lines.push('  d.appendChild(document.createTextNode(str));');
        lines.push('  return d.innerHTML;');
        lines.push('}');
        lines.push('');
        lines.push('function formatSize(bytes) {');
        lines.push('  if (bytes < 1024) return bytes + " B";');
        lines.push('  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";');
        lines.push('  return (bytes / 1048576).toFixed(1) + " MB";');
        lines.push('}');
        lines.push('');
        lines.push('function renderPage(records) {');
        lines.push('  tableBody.innerHTML = "";');
        lines.push('  if (records.length === 0) {');
        lines.push('    var tr = document.createElement("tr");');
        lines.push('    var td = document.createElement("td");');
        lines.push('    td.colSpan = 5;');
        lines.push('    td.className = "empty-msg";');
        lines.push('    td.textContent = "No records on this page";');
        lines.push('    tr.appendChild(td);');
        lines.push('    tableBody.appendChild(tr);');
        lines.push('    return;');
        lines.push('  }');
        lines.push('  for (var i = 0; i < records.length; i++) {');
        lines.push('    var r = records[i];');
        lines.push('    var tr = document.createElement("tr");');
        lines.push('    tr.className = "data-row";');
        lines.push('    tr.setAttribute("data-page-index", String(r.pageIndex));');
        lines.push('    var globalIdx = currentPage * 50 + r.pageIndex + 1;');
        // Build cells with DOM API instead of innerHTML to avoid HTML parsing issues
        lines.push('    var c1 = document.createElement("td"); c1.className = "col-idx"; c1.textContent = String(globalIdx);');
        lines.push('    var c2 = document.createElement("td"); c2.className = "col-oid"; c2.textContent = r.oid;');
        lines.push('    var c3 = document.createElement("td"); c3.className = "col-class"; c3.textContent = r.className;');
        lines.push('    var c4 = document.createElement("td"); c4.className = "col-fields"; c4.textContent = String(r.fieldCount);');
        lines.push('    var c5 = document.createElement("td"); c5.className = "col-size"; c5.textContent = formatSize(r.compressedSize) + " / " + formatSize(r.decompressedSize);');
        lines.push('    tr.appendChild(c1); tr.appendChild(c2); tr.appendChild(c3); tr.appendChild(c4); tr.appendChild(c5);');
        lines.push('    (function(idx) {');
        lines.push('      tr.addEventListener("click", function() { toggleRecord(idx); });');
        lines.push('    })(r.pageIndex);');
        lines.push('    tableBody.appendChild(tr);');
        lines.push('  }');
        lines.push('  updatePagination();');
        lines.push('}');
        lines.push('');
        lines.push('function toggleRecord(pageIndex) {');
        lines.push('  var oldSel = tableBody.querySelectorAll(".selected");');
        lines.push('  for (var i = 0; i < oldSel.length; i++) oldSel[i].classList.remove("selected");');
        lines.push('  var oldDetail = tableBody.querySelectorAll(".detail-row");');
        lines.push('  for (var i = 0; i < oldDetail.length; i++) oldDetail[i].remove();');
        lines.push('');
        lines.push('  if (expandedIdx === pageIndex) {');
        lines.push('    expandedIdx = -1;');
        lines.push('    return;');
        lines.push('  }');
        lines.push('');
        lines.push('  expandedIdx = pageIndex;');
        lines.push('  var rows = tableBody.querySelectorAll("tr.data-row");');
        lines.push('  var row = null;');
        lines.push('  for (var i = 0; i < rows.length; i++) {');
        lines.push('    if (rows[i].getAttribute("data-page-index") === String(pageIndex)) { row = rows[i]; break; }');
        lines.push('  }');
        lines.push('  if (row) row.classList.add("selected");');
        lines.push('');
        lines.push('  var detailTr = document.createElement("tr");');
        lines.push('  detailTr.className = "detail-row";');
        lines.push('  var detailTd = document.createElement("td");');
        lines.push('  detailTd.colSpan = 5;');
        lines.push('  var loadingDiv = document.createElement("div");');
        lines.push('  loadingDiv.className = "detail-panel";');
        lines.push('  loadingDiv.textContent = "Loading record details...";');
        lines.push('  detailTd.appendChild(loadingDiv);');
        lines.push('  detailTr.appendChild(detailTd);');
        lines.push('  if (row && row.nextSibling) {');
        lines.push('    tableBody.insertBefore(detailTr, row.nextSibling);');
        lines.push('  } else {');
        lines.push('    tableBody.appendChild(detailTr);');
        lines.push('  }');
        lines.push('');
        lines.push('  vscodeApi.postMessage({ type: "getRecord", pageIndex: pageIndex });');
        lines.push('}');
        lines.push('');
        lines.push('function renderRecordDetail(msg) {');
        lines.push('  var detailRow = tableBody.querySelector(".detail-row");');
        lines.push('  if (!detailRow) return;');
        lines.push('  var td = detailRow.querySelector("td");');
        lines.push('  if (!td) return;');
        lines.push('');
        lines.push('  var panel = document.createElement("div");');
        lines.push('  panel.className = "detail-panel";');
        lines.push('');
        lines.push('  var hdr = document.createElement("div");');
        lines.push('  hdr.className = "detail-header";');
        lines.push('  hdr.textContent = msg.className + " -- " + msg.oid + " ";');
        lines.push('  var b1 = document.createElement("span"); b1.className = "badge"; b1.textContent = msg.fields.length + " fields";');
        lines.push('  var b2 = document.createElement("span"); b2.className = "badge"; b2.textContent = formatSize(msg.decompressedSize);');
        lines.push('  hdr.appendChild(b1); hdr.appendChild(b2);');
        lines.push('  panel.appendChild(hdr);');
        lines.push('');
        lines.push('  var tbl = document.createElement("table");');
        lines.push('  tbl.className = "field-table";');
        lines.push('  var thead = document.createElement("thead");');
        lines.push('  var hrow = document.createElement("tr");');
        lines.push('  var headers = ["Field", "Type", "Size", "Value"];');
        lines.push('  var hclasses = ["fname", "ftype", "fsize", "fval"];');
        lines.push('  for (var h = 0; h < headers.length; h++) {');
        lines.push('    var th = document.createElement("th");');
        lines.push('    th.className = hclasses[h];');
        lines.push('    th.textContent = headers[h];');
        lines.push('    hrow.appendChild(th);');
        lines.push('  }');
        lines.push('  thead.appendChild(hrow);');
        lines.push('  tbl.appendChild(thead);');
        lines.push('');
        lines.push('  var tbody = document.createElement("tbody");');
        lines.push('  for (var i = 0; i < msg.fields.length; i++) {');
        lines.push('    var f = msg.fields[i];');
        lines.push('    var frow = document.createElement("tr");');
        lines.push('    var c1 = document.createElement("td");');
        lines.push('    c1.className = "fname" + (f.name.charAt(0) === "[" ? " field-unknown" : "");');
        lines.push('    c1.textContent = f.name;');
        lines.push('    var c2 = document.createElement("td"); c2.className = "ftype"; c2.textContent = f.type;');
        lines.push('    var c3 = document.createElement("td"); c3.className = "fsize"; c3.textContent = String(f.size);');
        lines.push('    var c4 = document.createElement("td"); c4.className = "fval"; c4.textContent = f.decoded;');
        lines.push('    frow.appendChild(c1); frow.appendChild(c2); frow.appendChild(c3); frow.appendChild(c4);');
        lines.push('    tbody.appendChild(frow);');
        lines.push('  }');
        lines.push('  tbl.appendChild(tbody);');
        lines.push('  panel.appendChild(tbl);');
        lines.push('');
        lines.push('  td.innerHTML = "";');
        lines.push('  td.appendChild(panel);');
        lines.push('}');
        lines.push('');
        lines.push('window.addEventListener("message", function(event) {');
        lines.push('  var msg = event.data;');
        lines.push('  switch (msg.type) {');
        lines.push('    case "metadata":');
        lines.push('      document.getElementById("dbName").textContent = msg.fileName;');
        lines.push('      document.getElementById("dbRecords").textContent = msg.recordCount.toLocaleString() + " records";');
        lines.push('      document.getElementById("dbType").textContent = msg.dbType.toUpperCase() + " (page " + msg.pageSize + ")";');
        lines.push('      totalPages = msg.totalPages;');
        lines.push('      updatePagination();');
        lines.push('      break;');
        lines.push('    case "page":');
        lines.push('      hideError();');
        lines.push('      currentPage = msg.pageNum;');
        lines.push('      totalPages = msg.totalPages;');
        lines.push('      renderPage(msg.records);');
        lines.push('      break;');
        lines.push('    case "recordDetail":');
        lines.push('      renderRecordDetail(msg);');
        lines.push('      break;');
        lines.push('    case "loading":');
        lines.push('      tableBody.innerHTML = "";');
        lines.push('      var ltr = document.createElement("tr");');
        lines.push('      var ltd = document.createElement("td");');
        lines.push('      ltd.colSpan = 5;');
        lines.push('      ltd.className = "loading";');
        lines.push('      ltd.textContent = "Loading page " + (msg.page + 1) + "...";');
        lines.push('      ltr.appendChild(ltd);');
        lines.push('      tableBody.appendChild(ltr);');
        lines.push('      break;');
        lines.push('    case "error":');
        lines.push('      showError(msg.message);');
        lines.push('      break;');
        lines.push('  }');
        lines.push('});');
        lines.push('');
        lines.push('document.addEventListener("keydown", function(e) {');
        lines.push('  if (e.key === "ArrowLeft" && e.altKey) { e.preventDefault(); if (!btnPrev.disabled) btnPrev.click(); }');
        lines.push('  if (e.key === "ArrowRight" && e.altKey) { e.preventDefault(); if (!btnNext.disabled) btnNext.click(); }');
        lines.push('});');
        lines.push('');
        lines.push('vscodeApi.postMessage({ type: "ready" });');
        lines.push('})();');
        lines.push('</script>');
        lines.push('</body>');
        lines.push('</html>');
        return lines.join('\n');
    }
}
