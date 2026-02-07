import * as vscode from 'vscode';
import { parseCRCTable, serializeCRCTable, CRCTable, CRCEntry } from './crcTableParser';
import { calculateCRC, formatCRC } from './crc';

class CRCEditorDocument implements vscode.CustomDocument {
    public table: CRCTable;

    constructor(
        public readonly uri: vscode.Uri,
        initialData: Uint8Array
    ) {
        this.table = parseCRCTable(initialData);
    }

    public dispose(): void {}
}

export class CRCEditorProvider implements vscode.CustomEditorProvider<CRCEditorDocument> {
    public static readonly viewType = 'crcEditor.crcTable';

    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<CRCEditorDocument>>();
    public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    constructor(private readonly context: vscode.ExtensionContext) {}

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new CRCEditorProvider(context);
        return vscode.window.registerCustomEditorProvider(
            CRCEditorProvider.viewType,
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
    ): Promise<CRCEditorDocument> {
        const data = await vscode.workspace.fs.readFile(uri);
        return new CRCEditorDocument(uri, data);
    }

    async resolveCustomEditor(
        document: CRCEditorDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true
        };

        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

        const sendData = () => {
            webviewPanel.webview.postMessage({
                type: 'load',
                data: {
                    totalEntries: document.table.entries.length,
                    filePath: document.uri.fsPath
                }
            });
        };

        webviewPanel.webview.onDidReceiveMessage(async e => {
            switch (e.type) {
                case 'ready':
                    sendData();
                    break;
                case 'search':
                    const results = this.searchEntries(document, e.query, e.limit || 100);
                    webviewPanel.webview.postMessage({ type: 'searchResults', results });
                    break;
                case 'add':
                    const newEntry = this.addEntry(document, e.path);
                    webviewPanel.webview.postMessage({ type: 'entryAdded', entry: newEntry });
                    sendData(); // Update count
                    break;
                case 'delete':
                    this.deleteEntry(document, e.crc);
                    webviewPanel.webview.postMessage({ type: 'entryDeleted' });
                    sendData(); // Update count
                    break;
                case 'calculateCRC':
                    const crc = calculateCRC(e.path);
                    webviewPanel.webview.postMessage({
                        type: 'crcCalculated',
                        path: e.path,
                        crc: crc,
                        crcHex: formatCRC(crc)
                    });
                    break;
                case 'saveDocument':
                    try {
                        const data = serializeCRCTable(document.table);
                        await vscode.workspace.fs.writeFile(document.uri, data);
                        webviewPanel.webview.postMessage({ type: 'documentSaved' });
                    } catch (err: any) {
                        webviewPanel.webview.postMessage({ type: 'saveError', error: err.message });
                    }
                    break;
            }
        });
    }

    private searchEntries(document: CRCEditorDocument, query: string, limit: number): CRCEntry[] {
        if (!query || query.trim() === '') {
            // Return first N entries if no query
            return document.table.entries.slice(0, limit);
        }

        const lowerQuery = query.toLowerCase();
        const results: CRCEntry[] = [];

        for (const entry of document.table.entries) {
            if (entry.path.toLowerCase().includes(lowerQuery)) {
                results.push(entry);
                if (results.length >= limit) break;
            }
        }

        return results;
    }

    private addEntry(document: CRCEditorDocument, path: string): CRCEntry {
        const crc = calculateCRC(path);
        const entry: CRCEntry = { crc, path };

        // Check if already exists
        const existing = document.table.entries.find(e => e.crc === crc);
        if (existing) {
            throw new Error(`Entry already exists: ${existing.path}`);
        }

        document.table.entries.push(entry);

        // Sort by path
        document.table.entries.sort((a, b) => a.path.localeCompare(b.path));

        this._onDidChangeCustomDocument.fire({
            document,
            undo: () => {
                const idx = document.table.entries.findIndex(e => e.crc === crc);
                if (idx >= 0) document.table.entries.splice(idx, 1);
            },
            redo: () => {
                document.table.entries.push(entry);
                document.table.entries.sort((a, b) => a.path.localeCompare(b.path));
            }
        });

        return entry;
    }

    private deleteEntry(document: CRCEditorDocument, crc: number): void {
        const idx = document.table.entries.findIndex(e => e.crc === crc);
        if (idx < 0) return;

        const removed = document.table.entries.splice(idx, 1)[0];

        this._onDidChangeCustomDocument.fire({
            document,
            undo: () => {
                document.table.entries.push(removed);
                document.table.entries.sort((a, b) => a.path.localeCompare(b.path));
            },
            redo: () => {
                const i = document.table.entries.findIndex(e => e.crc === crc);
                if (i >= 0) document.table.entries.splice(i, 1);
            }
        });
    }

    async saveCustomDocument(
        document: CRCEditorDocument,
        _cancellation: vscode.CancellationToken
    ): Promise<void> {
        const data = serializeCRCTable(document.table);
        await vscode.workspace.fs.writeFile(document.uri, data);
    }

    async saveCustomDocumentAs(
        document: CRCEditorDocument,
        destination: vscode.Uri,
        _cancellation: vscode.CancellationToken
    ): Promise<void> {
        const data = serializeCRCTable(document.table);
        await vscode.workspace.fs.writeFile(destination, data);
    }

    async revertCustomDocument(
        document: CRCEditorDocument,
        _cancellation: vscode.CancellationToken
    ): Promise<void> {
        const data = await vscode.workspace.fs.readFile(document.uri);
        document.table = parseCRCTable(data);
    }

    async backupCustomDocument(
        document: CRCEditorDocument,
        context: vscode.CustomDocumentBackupContext,
        _cancellation: vscode.CancellationToken
    ): Promise<vscode.CustomDocumentBackup> {
        const data = serializeCRCTable(document.table);
        await vscode.workspace.fs.writeFile(context.destination, data);
        return {
            id: context.destination.toString(),
            delete: () => vscode.workspace.fs.delete(context.destination)
        };
    }

    private getHtmlForWebview(_webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CRC Table Editor</title>
    <style>
        * {
            box-sizing: border-box;
        }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0;
            padding: 16px;
            line-height: 1.4;
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .header h2 {
            margin: 0;
            font-size: 14px;
            font-weight: 600;
        }

        .entry-count {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }

        .section {
            margin-bottom: 24px;
        }

        .section-title {
            font-size: 13px;
            font-weight: 600;
            margin-bottom: 12px;
            color: var(--vscode-foreground);
        }

        .search-container {
            display: flex;
            gap: 8px;
            margin-bottom: 12px;
        }

        .search-input {
            flex: 1;
            padding: 8px 12px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            color: var(--vscode-input-foreground);
            border-radius: 4px;
            font-size: 13px;
        }

        .search-input:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }

        button {
            padding: 8px 16px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }

        button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        button.danger {
            background: var(--vscode-testing-iconFailed, #f44747);
            color: #fff;
        }

        .add-container {
            display: flex;
            gap: 8px;
            margin-bottom: 8px;
        }

        .add-input {
            flex: 1;
            padding: 8px 12px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            color: var(--vscode-input-foreground);
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family), monospace;
            font-size: 12px;
        }

        .add-input:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }

        .crc-preview {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 12px;
            font-family: var(--vscode-editor-font-family), monospace;
        }

        .crc-preview .crc-value {
            color: var(--vscode-symbolIcon-functionForeground, #DCDCAA);
        }

        .results {
            max-height: 400px;
            overflow-y: auto;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }

        .result-item {
            display: flex;
            align-items: center;
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            gap: 12px;
        }

        .result-item:last-child {
            border-bottom: none;
        }

        .result-item:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .result-crc {
            font-family: var(--vscode-editor-font-family), monospace;
            font-size: 11px;
            color: var(--vscode-symbolIcon-functionForeground, #DCDCAA);
            min-width: 80px;
        }

        .result-path {
            flex: 1;
            font-family: var(--vscode-editor-font-family), monospace;
            font-size: 12px;
            word-break: break-all;
        }

        .result-delete {
            padding: 4px 8px;
            font-size: 11px;
            opacity: 0;
            transition: opacity 0.15s;
        }

        .result-item:hover .result-delete {
            opacity: 1;
        }

        .no-results {
            padding: 24px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
        }

        .status-message {
            position: fixed;
            bottom: 60px;
            left: 50%;
            transform: translateX(-50%);
            padding: 8px 16px;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            font-size: 12px;
            display: none;
            z-index: 101;
        }

        .status-message.visible {
            display: block;
        }

        .status-message.success {
            border-color: var(--vscode-testing-iconPassed, #4ec9b0);
            color: var(--vscode-testing-iconPassed, #4ec9b0);
        }

        .status-message.error {
            border-color: var(--vscode-testing-iconFailed, #f44747);
            color: var(--vscode-testing-iconFailed, #f44747);
        }

        .save-bar {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            padding: 12px 16px;
            background: var(--vscode-editorWidget-background);
            border-top: 1px solid var(--vscode-panel-border);
            display: none;
            align-items: center;
            justify-content: space-between;
            z-index: 100;
        }

        .save-bar.visible {
            display: flex;
        }

        .save-bar .save-btn {
            background: var(--vscode-testing-iconPassed, #4ec9b0);
            color: #000;
        }
    </style>
</head>
<body>
    <div class="header">
        <div>
            <h2 id="filename">CRC String Table</h2>
            <div class="entry-count" id="entry-count">Loading...</div>
        </div>
    </div>

    <div class="section">
        <div class="section-title">Add New Entry</div>
        <div class="add-container">
            <input type="text" class="add-input" id="add-path" placeholder="object/tangible/example/my_item.iff">
            <button id="add-btn">Add Entry</button>
        </div>
        <div class="crc-preview" id="crc-preview"></div>
    </div>

    <div class="section">
        <div class="section-title">Search Entries</div>
        <div class="search-container">
            <input type="text" class="search-input" id="search-input" placeholder="Search by path...">
            <button id="search-btn">Search</button>
        </div>
        <div class="results" id="results">
            <div class="no-results">Type to search or press Search to see entries</div>
        </div>
    </div>

    <div class="save-bar" id="save-bar">
        <span>Unsaved changes</span>
        <button class="save-btn" id="save-btn">Save File</button>
    </div>

    <div class="status-message" id="status-message"></div>

    <script>
        const vscode = acquireVsCodeApi();
        let documentDirty = false;

        // Elements
        const addPathInput = document.getElementById('add-path');
        const addBtn = document.getElementById('add-btn');
        const crcPreview = document.getElementById('crc-preview');
        const searchInput = document.getElementById('search-input');
        const searchBtn = document.getElementById('search-btn');
        const resultsContainer = document.getElementById('results');
        const entryCount = document.getElementById('entry-count');
        const saveBar = document.getElementById('save-bar');
        const saveBtn = document.getElementById('save-btn');
        const statusMessage = document.getElementById('status-message');

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'load':
                    document.getElementById('filename').textContent = message.data.filePath.split(/[\\\\/]/).pop();
                    entryCount.textContent = message.data.totalEntries.toLocaleString() + ' entries';
                    // Initial search to show some entries
                    vscode.postMessage({ type: 'search', query: '', limit: 50 });
                    break;
                case 'searchResults':
                    renderResults(message.results);
                    break;
                case 'entryAdded':
                    showStatus('Added: ' + message.entry.path, 'success');
                    documentDirty = true;
                    updateSaveBar();
                    addPathInput.value = '';
                    crcPreview.innerHTML = '';
                    // Refresh search
                    doSearch();
                    break;
                case 'entryDeleted':
                    showStatus('Entry deleted', 'success');
                    documentDirty = true;
                    updateSaveBar();
                    doSearch();
                    break;
                case 'crcCalculated':
                    crcPreview.innerHTML = 'CRC: <span class="crc-value">' + message.crcHex + '</span> (' + message.crc + ')';
                    break;
                case 'documentSaved':
                    showStatus('File saved successfully!', 'success');
                    documentDirty = false;
                    updateSaveBar();
                    break;
                case 'saveError':
                    showStatus('Save failed: ' + message.error, 'error');
                    break;
            }
        });

        function showStatus(msg, type) {
            statusMessage.textContent = msg;
            statusMessage.className = 'status-message visible ' + (type || '');
            setTimeout(() => {
                statusMessage.classList.remove('visible');
            }, 3000);
        }

        function updateSaveBar() {
            if (documentDirty) {
                saveBar.classList.add('visible');
            } else {
                saveBar.classList.remove('visible');
            }
        }

        function renderResults(results) {
            if (results.length === 0) {
                resultsContainer.innerHTML = '<div class="no-results">No results found</div>';
                return;
            }

            resultsContainer.innerHTML = results.map(entry => \`
                <div class="result-item" data-crc="\${entry.crc}">
                    <span class="result-crc">\${entry.crc.toString(16).toUpperCase().padStart(8, '0')}</span>
                    <span class="result-path">\${escapeHtml(entry.path)}</span>
                    <button class="result-delete danger" data-crc="\${entry.crc}">Delete</button>
                </div>
            \`).join('');

            // Add delete handlers
            resultsContainer.querySelectorAll('.result-delete').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const crc = parseInt(btn.dataset.crc);
                    if (confirm('Delete this entry?')) {
                        vscode.postMessage({ type: 'delete', crc: crc });
                    }
                });
            });
        }

        function escapeHtml(str) {
            return str
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        function doSearch() {
            vscode.postMessage({ type: 'search', query: searchInput.value, limit: 100 });
        }

        // Event handlers
        addPathInput.addEventListener('input', () => {
            const path = addPathInput.value.trim();
            if (path) {
                vscode.postMessage({ type: 'calculateCRC', path: path });
            } else {
                crcPreview.innerHTML = '';
            }
        });

        addBtn.addEventListener('click', () => {
            const path = addPathInput.value.trim();
            if (path) {
                vscode.postMessage({ type: 'add', path: path });
            }
        });

        addPathInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                addBtn.click();
            }
        });

        searchInput.addEventListener('input', () => {
            // Debounce search
            clearTimeout(searchInput._debounce);
            searchInput._debounce = setTimeout(doSearch, 300);
        });

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                doSearch();
            }
        });

        searchBtn.addEventListener('click', doSearch);

        saveBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'saveDocument' });
        });

        // Notify extension we're ready
        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
    }
}
