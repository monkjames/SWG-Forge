import * as vscode from 'vscode';
import * as path from 'path';
import { getDbStats, getRecordPage, getRecordPageByClass, getRecordsByKeys, formatOID, oidTableId, DbStats, RawRecord } from './bdbAccess';
import { getCacheInfo, getCachePath, buildCache, deleteCache, queryRecordPage, queryClassIndex, queryClassRecordPage, queryClassOidKeys, CacheInfo } from './bdbCache';
import { parseRecordSummary, parseRecordDetail } from './fieldParser';
import { loadReferenceData, annotateField, ReferenceData } from './referenceData';

const PAGE_SIZE = 50;
const LOG = vscode.window.createOutputChannel('BDB Viewer');

class BDBDocument implements vscode.CustomDocument {
    public stats: DbStats | null = null;
    public cacheInfo: CacheInfo = { exists: false };
    public currentPageRecords: RawRecord[] = [];
    public currentPageNum: number = -1;
    public currentPageRawLoading: Promise<void> | null = null;
    public cacheBuildCancel: (() => void) | null = null;
    public referenceData: ReferenceData | null = null;

    constructor(public readonly uri: vscode.Uri) {}
    public dispose(): void {
        if (this.cacheBuildCancel) {
            this.cacheBuildCancel();
            this.cacheBuildCancel = null;
        }
    }
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
                    case 'buildCache':
                        this.handleBuildCache(document, webviewPanel);
                        break;
                    case 'cancelCacheBuild':
                        this.handleCancelCacheBuild(document);
                        break;
                    case 'deleteCache':
                        await this.handleDeleteCache(document, webviewPanel);
                        break;
                    case 'scanClasses':
                        await this.handleScanClasses(document, webviewPanel);
                        break;
                    case 'getClassPage':
                        await this.handleGetClassPage(document, webviewPanel, msg.className, msg.page);
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

        webviewPanel.webview.html = this.getHtml();
        LOG.appendLine('[resolveCustomEditor] HTML set, waiting for ready message');
    }

    // ---- Handlers ----

    private async handleReady(document: BDBDocument, panel: vscode.WebviewPanel): Promise<void> {
        const fileName = path.basename(document.uri.fsPath);
        LOG.appendLine('[handleReady] ' + fileName + ' at ' + document.uri.fsPath);
        try {
            const [stats, cacheInfo, refData] = await Promise.all([
                getDbStats(document.uri.fsPath),
                getCacheInfo(document.uri.fsPath),
                loadReferenceData(document.uri.fsPath)
            ]);
            document.stats = stats;
            document.cacheInfo = cacheInfo;
            document.referenceData = refData;
            LOG.appendLine('[handleReady] stats: ' + JSON.stringify(document.stats) + ' cache: ' + JSON.stringify(document.cacheInfo) + ' refCRCs: ' + refData.crcTable.size + ' zones: ' + refData.zoneNames.size);

            const totalRecords = document.cacheInfo.exists && document.cacheInfo.totalRecords
                ? document.cacheInfo.totalRecords
                : document.stats.recordCount;
            const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));

            panel.webview.postMessage({
                type: 'metadata',
                fileName,
                recordCount: totalRecords,
                dbType: document.stats.dbType,
                pageSize: document.stats.pageSize,
                totalPages,
                cached: document.cacheInfo.exists,
                cacheTime: document.cacheInfo.buildTime || null
            });
            LOG.appendLine('[handleReady] metadata sent, loading page 0');
            await this.handleGetPage(document, panel, 0);
        } catch (err: any) {
            LOG.appendLine('[handleReady] ERROR: ' + err.message);
            panel.webview.postMessage({
                type: 'error',
                message: 'Failed to read database: ' + err.message
            });
        }
    }

    private async handleGetPage(document: BDBDocument, panel: vscode.WebviewPanel, page: number): Promise<void> {
        LOG.appendLine('[handleGetPage] page=' + page + ' cached=' + document.cacheInfo.exists);
        panel.webview.postMessage({ type: 'loading', page });

        try {
            if (document.cacheInfo.exists) {
                // Query cache for instant pagination
                const cachePath = getCachePath(document.uri.fsPath);
                const cached = await queryRecordPage(cachePath, page, PAGE_SIZE);

                const records = cached.map((r, i) => ({
                    pageIndex: i,
                    oid: r.oid,
                    tableId: 0,
                    className: r.className,
                    fieldCount: r.fieldCount,
                    compressedSize: r.compressedSize,
                    decompressedSize: r.decompressedSize
                }));

                const totalRecords = document.cacheInfo.totalRecords || document.stats?.recordCount || 0;
                const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));

                panel.webview.postMessage({
                    type: 'page',
                    records,
                    pageNum: page,
                    totalPages
                });

                // Background: load raw records for detail expand
                document.currentPageNum = page;
                document.currentPageRecords = [];
                document.currentPageRawLoading = getRecordPage(document.uri.fsPath, page, PAGE_SIZE)
                    .then(raw => { document.currentPageRecords = raw; })
                    .catch(err => { LOG.appendLine('[handleGetPage] background raw load error: ' + err.message); });
            } else {
                // Stream from BDB (no cache)
                const rawRecords = await getRecordPage(document.uri.fsPath, page, PAGE_SIZE);
                document.currentPageRecords = rawRecords;
                document.currentPageNum = page;
                document.currentPageRawLoading = null;

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

                panel.webview.postMessage({
                    type: 'page',
                    records,
                    pageNum: page,
                    totalPages
                });
            }
        } catch (err: any) {
            LOG.appendLine('[handleGetPage] ERROR: ' + err.message);
            panel.webview.postMessage({
                type: 'error',
                message: 'Failed to read page ' + page + ': ' + err.message
            });
        }
    }

    private async handleGetRecord(document: BDBDocument, panel: vscode.WebviewPanel, pageIndex: number): Promise<void> {
        // Wait for raw records if loading in background (cache mode)
        if (document.currentPageRawLoading) {
            await document.currentPageRawLoading;
        }

        if (pageIndex < 0 || pageIndex >= document.currentPageRecords.length) {
            LOG.appendLine('[handleGetRecord] index out of range: ' + pageIndex + ' (have ' + document.currentPageRecords.length + ')');
            panel.webview.postMessage({
                type: 'error',
                message: 'Record not yet loaded. Try again in a moment.'
            });
            return;
        }

        try {
            const raw = document.currentPageRecords[pageIndex];
            const detail = parseRecordDetail(raw.valueHex);

            const fields = detail.fields.map(f => {
                const field: any = {
                    name: f.name,
                    type: f.type,
                    decoded: f.decoded,
                    size: f.size,
                    hash: '0x' + f.hash.toString(16).toUpperCase().padStart(8, '0')
                };
                if (document.referenceData) {
                    const ann = annotateField(f.name, f.type, f.decoded, document.referenceData);
                    if (ann) { field.annotation = ann; }
                }
                return field;
            });

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

    private handleBuildCache(document: BDBDocument, panel: vscode.WebviewPanel): void {
        if (document.cacheBuildCancel) {
            LOG.appendLine('[handleBuildCache] build already in progress');
            return;
        }

        const totalEstimate = document.stats?.recordCount || 0;
        LOG.appendLine('[handleBuildCache] starting cache build, ~' + totalEstimate + ' records');

        document.cacheBuildCancel = buildCache(
            document.uri.fsPath,
            totalEstimate,
            (scanned) => {
                try {
                    panel.webview.postMessage({
                        type: 'cacheProgress',
                        scanned,
                        totalRecords: totalEstimate
                    });
                } catch {}
            },
            async (totalRecords) => {
                LOG.appendLine('[handleBuildCache] done, ' + totalRecords + ' records cached');
                document.cacheBuildCancel = null;
                document.cacheInfo = await getCacheInfo(document.uri.fsPath);
                try {
                    panel.webview.postMessage({
                        type: 'cacheDone',
                        totalRecords,
                        cached: true,
                        cacheTime: document.cacheInfo.buildTime || null
                    });
                } catch {}
            },
            (err) => {
                LOG.appendLine('[handleBuildCache] ERROR: ' + err.message);
                document.cacheBuildCancel = null;
                try {
                    panel.webview.postMessage({
                        type: 'error',
                        message: 'Cache build failed: ' + err.message
                    });
                } catch {}
            }
        );
    }

    private handleCancelCacheBuild(document: BDBDocument): void {
        if (document.cacheBuildCancel) {
            LOG.appendLine('[handleCancelCacheBuild] cancelling');
            document.cacheBuildCancel();
            document.cacheBuildCancel = null;
        }
    }

    private async handleDeleteCache(document: BDBDocument, panel: vscode.WebviewPanel): Promise<void> {
        LOG.appendLine('[handleDeleteCache] deleting cache for ' + document.uri.fsPath);
        deleteCache(document.uri.fsPath);
        document.cacheInfo = { exists: false };
        panel.webview.postMessage({
            type: 'cacheDeleted'
        });
    }

    private async handleScanClasses(document: BDBDocument, panel: vscode.WebviewPanel): Promise<void> {
        if (!document.cacheInfo.exists) {
            panel.webview.postMessage({ type: 'noCacheForClasses' });
            return;
        }

        LOG.appendLine('[handleScanClasses] querying cache for class index');
        try {
            const cachePath = getCachePath(document.uri.fsPath);
            const classes = await queryClassIndex(cachePath);
            panel.webview.postMessage({
                type: 'classIndex',
                classes: classes.map(c => ({ className: c.className, count: c.count, avgSize: c.avgSize })),
                scanned: document.cacheInfo.totalRecords || 0,
                done: true
            });
        } catch (err: any) {
            LOG.appendLine('[handleScanClasses] ERROR: ' + err.message);
            panel.webview.postMessage({
                type: 'error',
                message: 'Failed to query class index: ' + err.message
            });
        }
    }

    private async handleGetClassPage(
        document: BDBDocument,
        panel: vscode.WebviewPanel,
        className: string,
        page: number
    ): Promise<void> {
        LOG.appendLine('[handleGetClassPage] class=' + className + ' page=' + page);
        panel.webview.postMessage({ type: 'classPageLoading', className, page });

        try {
            if (document.cacheInfo.exists) {
                // Fast path: use cache OIDs for key-matching (no decompression of non-matches)
                const cachePath = getCachePath(document.uri.fsPath);
                const { dumpKeys, total: knownTotal } = await queryClassOidKeys(cachePath, className, page, PAGE_SIZE);
                LOG.appendLine('[handleGetClassPage] cache: ' + dumpKeys.length + ' keys, total=' + knownTotal);

                const targetKeys = new Set(dumpKeys);
                const totalEst = document.stats?.recordCount || 0;

                const result = await getRecordsByKeys(document.uri.fsPath, targetKeys, (scanned, found) => {
                    try {
                        panel.webview.postMessage({
                            type: 'classPageProgress',
                            scanned,
                            total: totalEst,
                            found
                        });
                    } catch {}
                });

                LOG.appendLine('[handleGetClassPage] key-match got ' + result.records.length + ' records');
                this.annotateClassRecords(result.records, document.referenceData);
                const totalPages = Math.max(1, Math.ceil(knownTotal / PAGE_SIZE));

                panel.webview.postMessage({
                    type: 'classPage',
                    className,
                    records: result.records,
                    columns: result.columns,
                    pageNum: page,
                    totalPages,
                    totalMatching: knownTotal,
                    timedOut: result.timedOut || false
                });
            } else {
                // Slow path: no cache, stream and decompress every record
                const result = await getRecordPageByClass(document.uri.fsPath, className, page, PAGE_SIZE);
                LOG.appendLine('[handleGetClassPage] stream got ' + result.records.length + ' records');
                this.annotateClassRecords(result.records, document.referenceData);

                const totalPages = Math.max(1, Math.ceil(result.totalMatching / PAGE_SIZE));

                panel.webview.postMessage({
                    type: 'classPage',
                    className,
                    records: result.records,
                    columns: result.columns,
                    pageNum: page,
                    totalPages,
                    totalMatching: result.totalMatching,
                    timedOut: result.timedOut || false
                });
            }
        } catch (err: any) {
            LOG.appendLine('[handleGetClassPage] ERROR: ' + err.message);
            panel.webview.postMessage({
                type: 'error',
                message: 'Failed to load class page: ' + err.message
            });
        }
    }

    private annotateClassRecords(records: { oid: string; fields: { name: string; type: string; decoded: string; annotation?: string }[] }[], ref: ReferenceData | null): void {
        if (!ref) { return; }
        for (const rec of records) {
            for (const f of rec.fields) {
                const ann = annotateField(f.name, f.type, f.decoded, ref);
                if (ann) { f.annotation = ann; }
            }
        }
    }

    // ---- HTML ----

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
        lines.push('.badge-cached {');
        lines.push('  background: var(--vscode-testing-iconPassed, #388a34) !important;');
        lines.push('  color: #fff !important;');
        lines.push('}');
        lines.push('.cache-btn {');
        lines.push('  padding: 3px 10px; border: none; border-radius: 3px; cursor: pointer; font-size: 11px;');
        lines.push('  background: var(--vscode-button-secondaryBackground);');
        lines.push('  color: var(--vscode-button-secondaryForeground);');
        lines.push('}');
        lines.push('.cache-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }');
        // Tab bar
        lines.push('.tab-bar {');
        lines.push('  display: flex; gap: 0; margin-bottom: 8px;');
        lines.push('  border-bottom: 1px solid var(--vscode-panel-border);');
        lines.push('}');
        lines.push('.tab-btn {');
        lines.push('  padding: 8px 20px; background: none; border: none; border-bottom: 2px solid transparent;');
        lines.push('  color: var(--vscode-descriptionForeground); cursor: pointer; font-size: 13px;');
        lines.push('  font-family: var(--vscode-font-family);');
        lines.push('}');
        lines.push('.tab-btn:hover { color: var(--vscode-foreground); }');
        lines.push('.tab-btn.active {');
        lines.push('  color: var(--vscode-foreground); font-weight: 600;');
        lines.push('  border-bottom-color: var(--vscode-focusBorder);');
        lines.push('}');
        lines.push('.tab-content { display: none; }');
        lines.push('.tab-content.active { display: block; }');
        // Pagination
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
        // Table
        lines.push('.table-container {');
        lines.push('  overflow: auto; max-height: calc(100vh - 180px);');
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
        lines.push('.field-table .fname { width: 220px; font-weight: 500; }');
        lines.push('.field-table .ftype { width: 150px; color: var(--vscode-descriptionForeground); }');
        lines.push('.field-table .fsize { width: 50px; text-align: right; color: var(--vscode-descriptionForeground); }');
        lines.push('.field-table .fval { font-family: var(--vscode-editor-font-family); }');
        lines.push('.field-table .fref {');
        lines.push('  max-width: 300px; font-size: 10px; color: var(--vscode-textLink-foreground, #3794ff);');
        lines.push('  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;');
        lines.push('}');
        lines.push('.col-cell-annotated { color: var(--vscode-textLink-foreground, #3794ff); }');
        lines.push('.field-unknown { color: var(--vscode-descriptionForeground); font-style: italic; }');
        lines.push('.loading { padding: 20px; text-align: center; color: var(--vscode-descriptionForeground); }');
        lines.push('.error-msg {');
        lines.push('  padding: 12px; background: var(--vscode-inputValidation-errorBackground);');
        lines.push('  color: var(--vscode-inputValidation-errorForeground); border-radius: 4px;');
        lines.push('  margin-bottom: 8px; display: none;');
        lines.push('}');
        lines.push('.error-msg.visible { display: block; }');
        lines.push('.empty-msg { padding: 40px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 14px; }');
        // Class browser
        lines.push('.class-col-count { width: 100px; text-align: right; }');
        lines.push('.class-col-avg { width: 100px; text-align: right; color: var(--vscode-descriptionForeground); }');
        lines.push('.class-col-name { font-weight: 500; }');
        lines.push('.progress-bar-container {');
        lines.push('  display: flex; align-items: center; gap: 8px; padding: 8px 12px; margin-bottom: 8px;');
        lines.push('  font-size: 12px; color: var(--vscode-descriptionForeground);');
        lines.push('}');
        lines.push('.progress-bar {');
        lines.push('  flex: 1; height: 4px; background: var(--vscode-progressBar-background, #333);');
        lines.push('  border-radius: 2px; overflow: hidden;');
        lines.push('}');
        lines.push('.progress-fill {');
        lines.push('  height: 100%; background: var(--vscode-focusBorder);');
        lines.push('  transition: width 0.3s ease;');
        lines.push('}');
        lines.push('.back-btn {');
        lines.push('  padding: 4px 12px; background: var(--vscode-button-secondaryBackground);');
        lines.push('  color: var(--vscode-button-secondaryForeground); border: none; border-radius: 3px;');
        lines.push('  cursor: pointer; font-size: 12px; margin-right: 12px;');
        lines.push('}');
        lines.push('.back-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }');
        lines.push('.class-detail-header {');
        lines.push('  display: flex; align-items: center; gap: 12px; padding: 6px 0; margin-bottom: 8px;');
        lines.push('}');
        lines.push('.class-detail-header .class-name { font-weight: 600; font-size: 14px; }');
        lines.push('.col-cell {');
        lines.push('  max-width: 200px; overflow: hidden; text-overflow: ellipsis;');
        lines.push('  white-space: nowrap; padding: 6px 8px;');
        lines.push('}');
        lines.push('.col-cell:hover { overflow: visible; white-space: normal; word-break: break-all; }');
        lines.push('.no-cache-prompt {');
        lines.push('  display: flex; flex-direction: column; align-items: center; gap: 16px;');
        lines.push('  padding: 60px 20px; color: var(--vscode-descriptionForeground);');
        lines.push('}');
        lines.push('.no-cache-prompt button {');
        lines.push('  padding: 8px 24px; background: var(--vscode-button-background);');
        lines.push('  color: var(--vscode-button-foreground); border: none; border-radius: 4px;');
        lines.push('  cursor: pointer; font-size: 13px;');
        lines.push('}');
        lines.push('.no-cache-prompt button:hover { background: var(--vscode-button-hoverBackground); }');
        // Record overlay
        lines.push('.overlay-backdrop {');
        lines.push('  display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;');
        lines.push('  background: rgba(0,0,0,0.5); z-index: 100; justify-content: center; align-items: center;');
        lines.push('}');
        lines.push('.overlay-backdrop.visible { display: flex; }');
        lines.push('.overlay-panel {');
        lines.push('  background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border);');
        lines.push('  border-radius: 6px; width: 90%; max-width: 800px; max-height: 85vh;');
        lines.push('  display: flex; flex-direction: column; box-shadow: 0 8px 32px rgba(0,0,0,0.4);');
        lines.push('}');
        lines.push('.overlay-header {');
        lines.push('  display: flex; align-items: center; gap: 12px; padding: 12px 16px;');
        lines.push('  border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0;');
        lines.push('}');
        lines.push('.overlay-header .class-name { font-weight: 600; font-size: 14px; }');
        lines.push('.overlay-header .oid { font-family: var(--vscode-editor-font-family); font-size: 12px; color: var(--vscode-descriptionForeground); }');
        lines.push('.overlay-close {');
        lines.push('  margin-left: auto; background: none; border: none; color: var(--vscode-foreground);');
        lines.push('  font-size: 18px; cursor: pointer; padding: 4px 8px; border-radius: 3px;');
        lines.push('}');
        lines.push('.overlay-close:hover { background: var(--vscode-toolbar-hoverBackground); }');
        lines.push('.overlay-body { overflow: auto; padding: 0; flex: 1; }');
        lines.push('</style>');
        lines.push('</head>');
        lines.push('<body>');
        // Header
        lines.push('<div class="header">');
        lines.push('  <span class="filename" id="dbName">Loading...</span>');
        lines.push('  <span class="badge" id="dbRecords"></span>');
        lines.push('  <span class="badge" id="dbType"></span>');
        lines.push('  <span class="badge" id="dbCacheBadge" style="display:none"></span>');
        lines.push('  <button class="cache-btn" id="btnBuildCache" style="display:none">Build Cache</button>');
        lines.push('  <button class="cache-btn" id="btnRefreshCache" style="display:none">Refresh Cache</button>');
        lines.push('  <button class="cache-btn" id="btnDeleteCache" style="display:none">Delete Cache</button>');
        lines.push('</div>');
        lines.push('<div class="error-msg" id="errorMsg"></div>');
        // Cache progress
        lines.push('<div class="progress-bar-container" id="cacheProgress" style="display:none;">');
        lines.push('  <span id="cacheProgressText">Building cache...</span>');
        lines.push('  <div class="progress-bar"><div class="progress-fill" id="cacheFill" style="width:0%"></div></div>');
        lines.push('  <button class="cache-btn" id="btnCancelCache">Cancel</button>');
        lines.push('</div>');
        // Tab bar
        lines.push('<div class="tab-bar">');
        lines.push('  <button class="tab-btn active" id="tabRecords" data-tab="records">Records</button>');
        lines.push('  <button class="tab-btn" id="tabClasses" data-tab="classes">Classes</button>');
        lines.push('</div>');
        // ===== RECORDS TAB =====
        lines.push('<div class="tab-content active" id="viewRecords">');
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
        lines.push('</div>');
        // ===== CLASSES TAB =====
        lines.push('<div class="tab-content" id="viewClasses">');
        // No-cache prompt
        lines.push('<div id="noCachePrompt" class="no-cache-prompt">');
        lines.push('  <div style="font-size:14px;">Build a cache to browse by class</div>');
        lines.push('  <div style="font-size:12px;">Scans all records once and creates a SQLite index for instant browsing.</div>');
        lines.push('  <button id="btnBuildCachePrompt">Build Cache</button>');
        lines.push('</div>');
        // Class list view
        lines.push('<div id="classListView" style="display:none;">');
        lines.push('  <div class="table-container">');
        lines.push('    <table>');
        lines.push('      <thead><tr>');
        lines.push('        <th class="class-col-name">Class</th>');
        lines.push('        <th class="class-col-count">Count</th>');
        lines.push('        <th class="class-col-avg">Avg Size</th>');
        lines.push('      </tr></thead>');
        lines.push('      <tbody id="classListBody"></tbody>');
        lines.push('    </table>');
        lines.push('  </div>');
        lines.push('</div>');
        // Class detail view
        lines.push('<div id="classDetailView" style="display:none;">');
        lines.push('  <div class="class-detail-header">');
        lines.push('    <button class="back-btn" id="btnBackToClasses">&larr; Back</button>');
        lines.push('    <span class="class-name" id="classDetailName"></span>');
        lines.push('    <span class="badge" id="classDetailCount"></span>');
        lines.push('  </div>');
        lines.push('  <div class="pagination" id="classPaginationBar">');
        lines.push('    <button id="clsBtnFirst" title="First page">&laquo;</button>');
        lines.push('    <button id="clsBtnPrev" title="Previous page">&lsaquo;</button>');
        lines.push('    <span class="page-info" id="clsPageInfo">-</span>');
        lines.push('    <button id="clsBtnNext" title="Next page">&rsaquo;</button>');
        lines.push('    <button id="clsBtnLast" title="Last page">&raquo;</button>');
        lines.push('    <input type="number" class="jump-input" id="clsJumpInput" min="1" placeholder="#" title="Jump to page">');
        lines.push('    <button id="clsBtnJump">Go</button>');
        lines.push('  </div>');
        lines.push('  <div class="table-container" id="classDetailContainer">');
        lines.push('    <table>');
        lines.push('      <thead><tr id="classDetailHead"></tr></thead>');
        lines.push('      <tbody id="classDetailBody"></tbody>');
        lines.push('    </table>');
        lines.push('  </div>');
        lines.push('</div>');
        lines.push('</div>');
        // Record detail overlay
        lines.push('<div class="overlay-backdrop" id="recordOverlay">');
        lines.push('  <div class="overlay-panel">');
        lines.push('    <div class="overlay-header">');
        lines.push('      <span class="class-name" id="overlayClassName"></span>');
        lines.push('      <span class="oid" id="overlayOid"></span>');
        lines.push('      <span class="badge" id="overlayFieldCount"></span>');
        lines.push('      <button class="overlay-close" id="overlayClose" title="Close (Esc)">&times;</button>');
        lines.push('    </div>');
        lines.push('    <div class="overlay-body">');
        lines.push('      <table class="field-table">');
        lines.push('        <thead><tr><th class="fname">Field</th><th class="ftype">Type</th><th class="fsize">Size</th><th class="fval">Value</th><th class="fref">Ref</th></tr></thead>');
        lines.push('        <tbody id="overlayFieldBody"></tbody>');
        lines.push('      </table>');
        lines.push('    </div>');
        lines.push('  </div>');
        lines.push('</div>');
        // ===== JAVASCRIPT =====
        lines.push('<script>');
        lines.push('(function() {');
        lines.push('var vscodeApi = acquireVsCodeApi();');
        lines.push('');
        lines.push('// State');
        lines.push('var currentPage = 0;');
        lines.push('var totalPages = 1;');
        lines.push('var expandedIdx = -1;');
        lines.push('var isCached = false;');
        lines.push('var classListLoaded = false;');
        lines.push('var currentClassName = null;');
        lines.push('var clsCurrentPage = 0;');
        lines.push('var clsTotalPages = 1;');
        lines.push('var classColumns = [];');
        lines.push('');
        // Element refs
        lines.push('var tableBody = document.getElementById("tableBody");');
        lines.push('var pageInfo = document.getElementById("pageInfo");');
        lines.push('var btnFirst = document.getElementById("btnFirst");');
        lines.push('var btnPrev = document.getElementById("btnPrev");');
        lines.push('var btnNext = document.getElementById("btnNext");');
        lines.push('var btnLast = document.getElementById("btnLast");');
        lines.push('var btnJump = document.getElementById("btnJump");');
        lines.push('var jumpInput = document.getElementById("jumpInput");');
        lines.push('var errorMsg = document.getElementById("errorMsg");');
        lines.push('var tabRecords = document.getElementById("tabRecords");');
        lines.push('var tabClasses = document.getElementById("tabClasses");');
        lines.push('var viewRecords = document.getElementById("viewRecords");');
        lines.push('var viewClasses = document.getElementById("viewClasses");');
        lines.push('var dbCacheBadge = document.getElementById("dbCacheBadge");');
        lines.push('var btnBuildCache = document.getElementById("btnBuildCache");');
        lines.push('var btnRefreshCache = document.getElementById("btnRefreshCache");');
        lines.push('var btnDeleteCache = document.getElementById("btnDeleteCache");');
        lines.push('var cacheProgress = document.getElementById("cacheProgress");');
        lines.push('var cacheProgressText = document.getElementById("cacheProgressText");');
        lines.push('var cacheFill = document.getElementById("cacheFill");');
        lines.push('var btnCancelCache = document.getElementById("btnCancelCache");');
        lines.push('var noCachePrompt = document.getElementById("noCachePrompt");');
        lines.push('var classListView = document.getElementById("classListView");');
        lines.push('var classDetailView = document.getElementById("classDetailView");');
        lines.push('var classListBody = document.getElementById("classListBody");');
        lines.push('var classDetailName = document.getElementById("classDetailName");');
        lines.push('var classDetailCount = document.getElementById("classDetailCount");');
        lines.push('var classDetailHead = document.getElementById("classDetailHead");');
        lines.push('var classDetailBody = document.getElementById("classDetailBody");');
        lines.push('var clsPageInfo = document.getElementById("clsPageInfo");');
        lines.push('var clsBtnFirst = document.getElementById("clsBtnFirst");');
        lines.push('var clsBtnPrev = document.getElementById("clsBtnPrev");');
        lines.push('var clsBtnNext = document.getElementById("clsBtnNext");');
        lines.push('var clsBtnLast = document.getElementById("clsBtnLast");');
        lines.push('var clsBtnJump = document.getElementById("clsBtnJump");');
        lines.push('var clsJumpInput = document.getElementById("clsJumpInput");');
        lines.push('var btnBackToClasses = document.getElementById("btnBackToClasses");');
        lines.push('var btnBuildCachePrompt = document.getElementById("btnBuildCachePrompt");');
        lines.push('var recordOverlay = document.getElementById("recordOverlay");');
        lines.push('var overlayClassName = document.getElementById("overlayClassName");');
        lines.push('var overlayOid = document.getElementById("overlayOid");');
        lines.push('var overlayFieldCount = document.getElementById("overlayFieldCount");');
        lines.push('var overlayClose = document.getElementById("overlayClose");');
        lines.push('var overlayFieldBody = document.getElementById("overlayFieldBody");');
        lines.push('var classPageRecords = [];');
        lines.push('var classLoadingTimer = null;');
        lines.push('');
        // Overlay functions
        lines.push('function showRecordOverlay(rec) {');
        lines.push('  var cn = ""; for (var i = 0; i < rec.fields.length; i++) { if (rec.fields[i].name === "_className") { cn = rec.fields[i].decoded; break; } }');
        lines.push('  overlayClassName.textContent = cn || currentClassName || "";');
        lines.push('  overlayOid.textContent = rec.oid;');
        lines.push('  overlayFieldCount.textContent = rec.fields.length + " fields";');
        lines.push('  overlayFieldBody.innerHTML = "";');
        lines.push('  for (var i = 0; i < rec.fields.length; i++) {');
        lines.push('    var f = rec.fields[i]; var tr = document.createElement("tr");');
        lines.push('    var c1 = document.createElement("td"); c1.className = "fname" + (f.name.charAt(0) === "[" ? " field-unknown" : ""); c1.textContent = f.name;');
        lines.push('    var c2 = document.createElement("td"); c2.className = "ftype"; c2.textContent = f.type;');
        lines.push('    var c3 = document.createElement("td"); c3.className = "fsize"; c3.textContent = String(f.size);');
        lines.push('    var c4 = document.createElement("td"); c4.className = "fval"; c4.textContent = f.decoded;');
        lines.push('    var c5 = document.createElement("td"); c5.className = "fref"; c5.textContent = f.annotation || ""; if (f.annotation) c5.title = f.annotation;');
        lines.push('    tr.appendChild(c1); tr.appendChild(c2); tr.appendChild(c3); tr.appendChild(c4); tr.appendChild(c5); overlayFieldBody.appendChild(tr);');
        lines.push('  }');
        lines.push('  recordOverlay.classList.add("visible");');
        lines.push('}');
        lines.push('');
        lines.push('function closeOverlay() { recordOverlay.classList.remove("visible"); }');
        lines.push('overlayClose.addEventListener("click", closeOverlay);');
        lines.push('recordOverlay.addEventListener("click", function(e) { if (e.target === recordOverlay) closeOverlay(); });');
        lines.push('');
        // Cache controls
        lines.push('function updateCacheUI(cached, cacheTime) {');
        lines.push('  isCached = cached;');
        lines.push('  if (cached) {');
        lines.push('    dbCacheBadge.textContent = "Cached";');
        lines.push('    dbCacheBadge.className = "badge badge-cached";');
        lines.push('    dbCacheBadge.title = cacheTime ? "Built: " + cacheTime : "";');
        lines.push('    dbCacheBadge.style.display = "";');
        lines.push('    btnBuildCache.style.display = "none";');
        lines.push('    btnRefreshCache.style.display = "";');
        lines.push('    btnDeleteCache.style.display = "";');
        lines.push('    noCachePrompt.style.display = "none";');
        lines.push('  } else {');
        lines.push('    dbCacheBadge.textContent = "No Cache";');
        lines.push('    dbCacheBadge.className = "badge";');
        lines.push('    dbCacheBadge.style.display = "";');
        lines.push('    btnBuildCache.style.display = "";');
        lines.push('    btnRefreshCache.style.display = "none";');
        lines.push('    btnDeleteCache.style.display = "none";');
        lines.push('    noCachePrompt.style.display = "";');
        lines.push('    classListView.style.display = "none";');
        lines.push('  }');
        lines.push('}');
        lines.push('');
        lines.push('function startCacheBuild() {');
        lines.push('  cacheProgress.style.display = "flex";');
        lines.push('  cacheProgressText.textContent = "Building cache...";');
        lines.push('  cacheFill.style.width = "0%";');
        lines.push('  vscodeApi.postMessage({ type: "buildCache" });');
        lines.push('}');
        lines.push('');
        lines.push('btnBuildCache.addEventListener("click", startCacheBuild);');
        lines.push('btnBuildCachePrompt.addEventListener("click", startCacheBuild);');
        lines.push('btnRefreshCache.addEventListener("click", startCacheBuild);');
        lines.push('btnDeleteCache.addEventListener("click", function() {');
        lines.push('  vscodeApi.postMessage({ type: "deleteCache" });');
        lines.push('});');
        lines.push('btnCancelCache.addEventListener("click", function() {');
        lines.push('  vscodeApi.postMessage({ type: "cancelCacheBuild" });');
        lines.push('  cacheProgress.style.display = "none";');
        lines.push('});');
        lines.push('');
        // Tab switching
        lines.push('function switchTab(tab) {');
        lines.push('  tabRecords.classList.toggle("active", tab === "records");');
        lines.push('  tabClasses.classList.toggle("active", tab === "classes");');
        lines.push('  viewRecords.classList.toggle("active", tab === "records");');
        lines.push('  viewClasses.classList.toggle("active", tab === "classes");');
        lines.push('  if (tab === "classes" && isCached && !classListLoaded) {');
        lines.push('    classListLoaded = true;');
        lines.push('    vscodeApi.postMessage({ type: "scanClasses" });');
        lines.push('  }');
        lines.push('}');
        lines.push('tabRecords.addEventListener("click", function() { switchTab("records"); });');
        lines.push('tabClasses.addEventListener("click", function() { switchTab("classes"); });');
        lines.push('');
        // Records pagination
        lines.push('btnFirst.addEventListener("click", function() { goToPage(0); });');
        lines.push('btnPrev.addEventListener("click", function() { goToPage(currentPage - 1); });');
        lines.push('btnNext.addEventListener("click", function() { goToPage(currentPage + 1); });');
        lines.push('btnLast.addEventListener("click", function() { goToPage(totalPages - 1); });');
        lines.push('btnJump.addEventListener("click", function() {');
        lines.push('  var p = parseInt(jumpInput.value, 10);');
        lines.push('  if (p >= 1 && p <= totalPages) goToPage(p - 1);');
        lines.push('});');
        lines.push('jumpInput.addEventListener("keydown", function(e) { if (e.key === "Enter") btnJump.click(); });');
        lines.push('');
        lines.push('function goToPage(page) {');
        lines.push('  if (page < 0 || page >= totalPages) return;');
        lines.push('  currentPage = page; expandedIdx = -1;');
        lines.push('  vscodeApi.postMessage({ type: "getPage", page: page });');
        lines.push('}');
        lines.push('function updatePagination() {');
        lines.push('  pageInfo.textContent = "Page " + (currentPage + 1) + " of " + totalPages;');
        lines.push('  btnFirst.disabled = currentPage === 0;');
        lines.push('  btnPrev.disabled = currentPage === 0;');
        lines.push('  btnNext.disabled = currentPage >= totalPages - 1;');
        lines.push('  btnLast.disabled = currentPage >= totalPages - 1;');
        lines.push('  jumpInput.max = totalPages;');
        lines.push('}');
        lines.push('');
        // Class detail pagination
        lines.push('clsBtnFirst.addEventListener("click", function() { goToClassPage(0); });');
        lines.push('clsBtnPrev.addEventListener("click", function() { goToClassPage(clsCurrentPage - 1); });');
        lines.push('clsBtnNext.addEventListener("click", function() { goToClassPage(clsCurrentPage + 1); });');
        lines.push('clsBtnLast.addEventListener("click", function() { goToClassPage(clsTotalPages - 1); });');
        lines.push('clsBtnJump.addEventListener("click", function() {');
        lines.push('  var p = parseInt(clsJumpInput.value, 10);');
        lines.push('  if (p >= 1 && p <= clsTotalPages) goToClassPage(p - 1);');
        lines.push('});');
        lines.push('clsJumpInput.addEventListener("keydown", function(e) { if (e.key === "Enter") clsBtnJump.click(); });');
        lines.push('btnBackToClasses.addEventListener("click", function() {');
        lines.push('  currentClassName = null;');
        lines.push('  classDetailView.style.display = "none";');
        lines.push('  classListView.style.display = "block";');
        lines.push('});');
        lines.push('');
        lines.push('function goToClassPage(page) {');
        lines.push('  if (!currentClassName || page < 0 || page >= clsTotalPages) return;');
        lines.push('  clsCurrentPage = page;');
        lines.push('  vscodeApi.postMessage({ type: "getClassPage", className: currentClassName, page: page });');
        lines.push('}');
        lines.push('function updateClassPagination() {');
        lines.push('  clsPageInfo.textContent = "Page " + (clsCurrentPage + 1) + " of " + clsTotalPages;');
        lines.push('  clsBtnFirst.disabled = clsCurrentPage === 0;');
        lines.push('  clsBtnPrev.disabled = clsCurrentPage === 0;');
        lines.push('  clsBtnNext.disabled = clsCurrentPage >= clsTotalPages - 1;');
        lines.push('  clsBtnLast.disabled = clsCurrentPage >= clsTotalPages - 1;');
        lines.push('  clsJumpInput.max = clsTotalPages;');
        lines.push('}');
        lines.push('');
        // Shared helpers
        lines.push('function showError(msg) { errorMsg.textContent = msg; errorMsg.classList.add("visible"); }');
        lines.push('function hideError() { errorMsg.classList.remove("visible"); }');
        lines.push('function formatSize(b) { if (b < 1024) return b + " B"; if (b < 1048576) return (b / 1024).toFixed(1) + " KB"; return (b / 1048576).toFixed(1) + " MB"; }');
        lines.push('function fmtN(n) { return n.toLocaleString(); }');
        lines.push('');
        // Records page render
        lines.push('function renderPage(records) {');
        lines.push('  tableBody.innerHTML = "";');
        lines.push('  if (records.length === 0) { var tr = document.createElement("tr"); var td = document.createElement("td"); td.colSpan = 5; td.className = "empty-msg"; td.textContent = "No records on this page"; tr.appendChild(td); tableBody.appendChild(tr); return; }');
        lines.push('  for (var i = 0; i < records.length; i++) {');
        lines.push('    var r = records[i];');
        lines.push('    var tr = document.createElement("tr"); tr.className = "data-row"; tr.setAttribute("data-page-index", String(r.pageIndex));');
        lines.push('    var globalIdx = currentPage * 50 + r.pageIndex + 1;');
        lines.push('    var c1 = document.createElement("td"); c1.className = "col-idx"; c1.textContent = String(globalIdx);');
        lines.push('    var c2 = document.createElement("td"); c2.className = "col-oid"; c2.textContent = r.oid;');
        lines.push('    var c3 = document.createElement("td"); c3.className = "col-class"; c3.textContent = r.className;');
        lines.push('    var c4 = document.createElement("td"); c4.className = "col-fields"; c4.textContent = String(r.fieldCount);');
        lines.push('    var c5 = document.createElement("td"); c5.className = "col-size"; c5.textContent = formatSize(r.compressedSize) + " / " + formatSize(r.decompressedSize);');
        lines.push('    tr.appendChild(c1); tr.appendChild(c2); tr.appendChild(c3); tr.appendChild(c4); tr.appendChild(c5);');
        lines.push('    (function(idx) { tr.addEventListener("click", function() { toggleRecord(idx); }); })(r.pageIndex);');
        lines.push('    tableBody.appendChild(tr);');
        lines.push('  }');
        lines.push('  updatePagination();');
        lines.push('}');
        lines.push('');
        // Record detail toggle
        lines.push('function toggleRecord(pageIndex) {');
        lines.push('  var oldSel = tableBody.querySelectorAll(".selected"); for (var i = 0; i < oldSel.length; i++) oldSel[i].classList.remove("selected");');
        lines.push('  var oldDet = tableBody.querySelectorAll(".detail-row"); for (var i = 0; i < oldDet.length; i++) oldDet[i].remove();');
        lines.push('  if (expandedIdx === pageIndex) { expandedIdx = -1; return; }');
        lines.push('  expandedIdx = pageIndex;');
        lines.push('  var rows = tableBody.querySelectorAll("tr.data-row"); var row = null;');
        lines.push('  for (var i = 0; i < rows.length; i++) { if (rows[i].getAttribute("data-page-index") === String(pageIndex)) { row = rows[i]; break; } }');
        lines.push('  if (row) row.classList.add("selected");');
        lines.push('  var dtr = document.createElement("tr"); dtr.className = "detail-row";');
        lines.push('  var dtd = document.createElement("td"); dtd.colSpan = 5;');
        lines.push('  var ldv = document.createElement("div"); ldv.className = "detail-panel"; ldv.textContent = "Loading record details...";');
        lines.push('  dtd.appendChild(ldv); dtr.appendChild(dtd);');
        lines.push('  if (row && row.nextSibling) tableBody.insertBefore(dtr, row.nextSibling); else tableBody.appendChild(dtr);');
        lines.push('  vscodeApi.postMessage({ type: "getRecord", pageIndex: pageIndex });');
        lines.push('}');
        lines.push('');
        // Record detail render
        lines.push('function renderRecordDetail(msg) {');
        lines.push('  var dr = tableBody.querySelector(".detail-row"); if (!dr) return;');
        lines.push('  var td = dr.querySelector("td"); if (!td) return;');
        lines.push('  var panel = document.createElement("div"); panel.className = "detail-panel";');
        lines.push('  var hdr = document.createElement("div"); hdr.className = "detail-header";');
        lines.push('  hdr.textContent = msg.className + " -- " + msg.oid + " ";');
        lines.push('  var b1 = document.createElement("span"); b1.className = "badge"; b1.textContent = msg.fields.length + " fields";');
        lines.push('  var b2 = document.createElement("span"); b2.className = "badge"; b2.textContent = formatSize(msg.decompressedSize);');
        lines.push('  hdr.appendChild(b1); hdr.appendChild(b2); panel.appendChild(hdr);');
        lines.push('  var tbl = document.createElement("table"); tbl.className = "field-table";');
        lines.push('  var thead = document.createElement("thead"); var hrow = document.createElement("tr");');
        lines.push('  var headers = ["Field", "Type", "Size", "Value", "Ref"]; var hcls = ["fname", "ftype", "fsize", "fval", "fref"];');
        lines.push('  for (var h = 0; h < headers.length; h++) { var th = document.createElement("th"); th.className = hcls[h]; th.textContent = headers[h]; hrow.appendChild(th); }');
        lines.push('  thead.appendChild(hrow); tbl.appendChild(thead);');
        lines.push('  var tbody = document.createElement("tbody");');
        lines.push('  for (var i = 0; i < msg.fields.length; i++) {');
        lines.push('    var f = msg.fields[i]; var frow = document.createElement("tr");');
        lines.push('    var c1 = document.createElement("td"); c1.className = "fname" + (f.name.charAt(0) === "[" ? " field-unknown" : ""); c1.textContent = f.name;');
        lines.push('    var c2 = document.createElement("td"); c2.className = "ftype"; c2.textContent = f.type;');
        lines.push('    var c3 = document.createElement("td"); c3.className = "fsize"; c3.textContent = String(f.size);');
        lines.push('    var c4 = document.createElement("td"); c4.className = "fval"; c4.textContent = f.decoded;');
        lines.push('    var c5 = document.createElement("td"); c5.className = "fref"; c5.textContent = f.annotation || ""; if (f.annotation) c5.title = f.annotation;');
        lines.push('    frow.appendChild(c1); frow.appendChild(c2); frow.appendChild(c3); frow.appendChild(c4); frow.appendChild(c5); tbody.appendChild(frow);');
        lines.push('  }');
        lines.push('  tbl.appendChild(tbody); panel.appendChild(tbl);');
        lines.push('  td.innerHTML = ""; td.appendChild(panel);');
        lines.push('}');
        lines.push('');
        // Class list render
        lines.push('function renderClassList(classes) {');
        lines.push('  classListBody.innerHTML = "";');
        lines.push('  if (classes.length === 0) { var tr = document.createElement("tr"); var td = document.createElement("td"); td.colSpan = 3; td.className = "empty-msg"; td.textContent = "No classes found"; tr.appendChild(td); classListBody.appendChild(tr); return; }');
        lines.push('  for (var i = 0; i < classes.length; i++) {');
        lines.push('    var cls = classes[i]; var tr = document.createElement("tr"); tr.className = "data-row";');
        lines.push('    var c1 = document.createElement("td"); c1.className = "class-col-name"; c1.textContent = cls.className;');
        lines.push('    var c2 = document.createElement("td"); c2.className = "class-col-count"; c2.textContent = fmtN(cls.count);');
        lines.push('    var c3 = document.createElement("td"); c3.className = "class-col-avg"; c3.textContent = formatSize(cls.avgSize);');
        lines.push('    tr.appendChild(c1); tr.appendChild(c2); tr.appendChild(c3);');
        lines.push('    (function(name) { tr.addEventListener("click", function() { openClassDetail(name); }); })(cls.className);');
        lines.push('    classListBody.appendChild(tr);');
        lines.push('  }');
        lines.push('}');
        lines.push('');
        lines.push('function openClassDetail(className) {');
        lines.push('  currentClassName = className; clsCurrentPage = 0;');
        lines.push('  classListView.style.display = "none"; classDetailView.style.display = "block";');
        lines.push('  classDetailName.textContent = className; classDetailCount.textContent = "loading...";');
        lines.push('  classDetailHead.innerHTML = ""; classDetailBody.innerHTML = "";');
        lines.push('  var lt = document.createElement("tr"); var ltd = document.createElement("td"); ltd.className = "loading"; ltd.textContent = "Loading records..."; lt.appendChild(ltd); classDetailBody.appendChild(lt);');
        lines.push('  vscodeApi.postMessage({ type: "getClassPage", className: className, page: 0 });');
        lines.push('}');
        lines.push('');
        // Class detail columnar render
        lines.push('function renderClassPage(msg) {');
        lines.push('  classDetailCount.textContent = fmtN(msg.totalMatching) + " records";');
        lines.push('  clsCurrentPage = msg.pageNum; clsTotalPages = msg.totalPages;');
        lines.push('  classColumns = msg.columns; classPageRecords = msg.records; updateClassPagination();');
        lines.push('  classDetailHead.innerHTML = "";');
        lines.push('  var thOid = document.createElement("th"); thOid.textContent = "OID"; thOid.className = "col-oid"; classDetailHead.appendChild(thOid);');
        lines.push('  for (var c = 0; c < classColumns.length; c++) {');
        lines.push('    var th = document.createElement("th"); var cn = classColumns[c]; var di = cn.indexOf(".");');
        lines.push('    th.textContent = di >= 0 ? cn.substring(di + 1) : cn; th.title = cn; classDetailHead.appendChild(th);');
        lines.push('  }');
        lines.push('  classDetailBody.innerHTML = "";');
        lines.push('  if (msg.records.length === 0) { var tr = document.createElement("tr"); var td = document.createElement("td"); td.colSpan = classColumns.length + 1; td.className = "empty-msg"; td.textContent = "No records"; tr.appendChild(td); classDetailBody.appendChild(tr); return; }');
        lines.push('  for (var i = 0; i < msg.records.length; i++) {');
        lines.push('    var rec = msg.records[i]; var tr = document.createElement("tr"); tr.className = "data-row";');
        lines.push('    var tdO = document.createElement("td"); tdO.className = "col-oid"; tdO.textContent = rec.oid; tr.appendChild(tdO);');
        lines.push('    var fm = {}; var am = {}; for (var f = 0; f < rec.fields.length; f++) { fm[rec.fields[f].name] = rec.fields[f].decoded; if (rec.fields[f].annotation) am[rec.fields[f].name] = rec.fields[f].annotation; }');
        lines.push('    for (var c = 0; c < classColumns.length; c++) {');
        lines.push('      var td = document.createElement("td"); td.className = "col-cell";');
        lines.push('      var v = fm[classColumns[c]]; var ann = am[classColumns[c]];');
        lines.push('      if (ann) { td.textContent = ann; td.title = (v || "") + " -> " + ann; td.classList.add("col-cell-annotated"); }');
        lines.push('      else { td.textContent = v !== undefined ? v : ""; td.title = v !== undefined ? v : ""; }');
        lines.push('      tr.appendChild(td);');
        lines.push('    }');
        lines.push('    (function(idx) { tr.addEventListener("click", function() { showRecordOverlay(classPageRecords[idx]); }); })(i);');
        lines.push('    classDetailBody.appendChild(tr);');
        lines.push('  }');
        lines.push('}');
        lines.push('');
        // Message handler
        lines.push('window.addEventListener("message", function(event) {');
        lines.push('  var msg = event.data;');
        lines.push('  switch (msg.type) {');
        lines.push('    case "metadata":');
        lines.push('      document.getElementById("dbName").textContent = msg.fileName;');
        lines.push('      document.getElementById("dbRecords").textContent = msg.recordCount.toLocaleString() + " records";');
        lines.push('      document.getElementById("dbType").textContent = msg.dbType.toUpperCase() + " (page " + msg.pageSize + ")";');
        lines.push('      totalPages = msg.totalPages; updatePagination();');
        lines.push('      updateCacheUI(msg.cached, msg.cacheTime);');
        lines.push('      break;');
        lines.push('    case "page":');
        lines.push('      hideError(); currentPage = msg.pageNum; totalPages = msg.totalPages; renderPage(msg.records); break;');
        lines.push('    case "recordDetail":');
        lines.push('      renderRecordDetail(msg); break;');
        lines.push('    case "loading":');
        lines.push('      tableBody.innerHTML = ""; var ltr = document.createElement("tr"); var ltd = document.createElement("td"); ltd.colSpan = 5; ltd.className = "loading"; ltd.textContent = "Loading page " + (msg.page + 1) + "..."; ltr.appendChild(ltd); tableBody.appendChild(ltr); break;');
        // Cache events
        lines.push('    case "cacheProgress":');
        lines.push('      var pct = msg.totalRecords > 0 ? Math.round((msg.scanned / msg.totalRecords) * 100) : 0;');
        lines.push('      cacheProgressText.textContent = "Building cache... " + fmtN(msg.scanned) + " / " + fmtN(msg.totalRecords) + " (" + pct + "%)";');
        lines.push('      cacheFill.style.width = pct + "%"; break;');
        lines.push('    case "cacheDeleted":');
        lines.push('      updateCacheUI(false, null);');
        lines.push('      classListLoaded = false; currentClassName = null;');
        lines.push('      classListView.style.display = "none"; classDetailView.style.display = "none";');
        lines.push('      noCachePrompt.style.display = "";');
        lines.push('      break;');
        lines.push('    case "cacheDone":');
        lines.push('      cacheProgress.style.display = "none";');
        lines.push('      updateCacheUI(msg.cached, msg.cacheTime);');
        lines.push('      classListLoaded = false;');
        // Reload the current records page from cache + auto-load class list if on classes tab
        lines.push('      goToPage(currentPage);');
        lines.push('      if (viewClasses.classList.contains("active")) { classListLoaded = true; vscodeApi.postMessage({ type: "scanClasses" }); }');
        lines.push('      break;');
        // Class events
        lines.push('    case "classIndex":');
        lines.push('      classListView.style.display = "block"; noCachePrompt.style.display = "none";');
        lines.push('      renderClassList(msg.classes); break;');
        lines.push('    case "noCacheForClasses":');
        lines.push('      noCachePrompt.style.display = ""; classListView.style.display = "none"; break;');
        lines.push('    case "classPage":');
        lines.push('      if (classLoadingTimer) { clearInterval(classLoadingTimer); classLoadingTimer = null; }');
        lines.push('      if (msg.timedOut) { showError("Scan timed out after 60s. Found " + msg.records.length + " of " + msg.totalMatching + " matching records. Build a cache for instant results."); }');
        lines.push('      else { hideError(); }');
        lines.push('      renderClassPage(msg); break;');
        lines.push('    case "classPageLoading":');
        lines.push('      if (classLoadingTimer) { clearInterval(classLoadingTimer); classLoadingTimer = null; }');
        lines.push('      classDetailBody.innerHTML = ""; var lt2 = document.createElement("tr"); var ltc = document.createElement("td");');
        lines.push('      ltc.colSpan = classColumns.length + 1 || 1; ltc.className = "loading";');
        lines.push('      ltc.textContent = "Scanning database for matching records... (0s)";');
        lines.push('      lt2.appendChild(ltc); classDetailBody.appendChild(lt2);');
        lines.push('      var loadStart = Date.now();');
        lines.push('      classLoadingTimer = setInterval(function() {');
        lines.push('        var elapsed = Math.round((Date.now() - loadStart) / 1000);');
        lines.push('        ltc.textContent = "Scanning database for matching records... (" + elapsed + "s)";');
        lines.push('      }, 1000);');
        lines.push('      break;');
        lines.push('    case "classPageProgress":');
        lines.push('      var pctCls = msg.total > 0 ? Math.round((msg.scanned / msg.total) * 100) : 0;');
        lines.push('      var progCell = classDetailBody.querySelector(".loading");');
        lines.push('      if (progCell) progCell.textContent = "Scanning... " + fmtN(msg.scanned) + " / " + fmtN(msg.total) + " (" + pctCls + "%) — found " + msg.found + " records";');
        lines.push('      break;');
        lines.push('    case "error":');
        lines.push('      if (classLoadingTimer) { clearInterval(classLoadingTimer); classLoadingTimer = null; }');
        lines.push('      showError(msg.message); break;');
        lines.push('  }');
        lines.push('});');
        lines.push('');
        // Keyboard shortcuts
        lines.push('document.addEventListener("keydown", function(e) {');
        lines.push('  if (e.key === "ArrowLeft" && e.altKey) { e.preventDefault();');
        lines.push('    if (viewClasses.classList.contains("active") && currentClassName) { if (!clsBtnPrev.disabled) clsBtnPrev.click(); }');
        lines.push('    else { if (!btnPrev.disabled) btnPrev.click(); }');
        lines.push('  }');
        lines.push('  if (e.key === "ArrowRight" && e.altKey) { e.preventDefault();');
        lines.push('    if (viewClasses.classList.contains("active") && currentClassName) { if (!clsBtnNext.disabled) clsBtnNext.click(); }');
        lines.push('    else { if (!btnNext.disabled) btnNext.click(); }');
        lines.push('  }');
        lines.push('  if (e.key === "Escape") { if (recordOverlay.classList.contains("visible")) { closeOverlay(); return; } if (currentClassName) btnBackToClasses.click(); }');
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
