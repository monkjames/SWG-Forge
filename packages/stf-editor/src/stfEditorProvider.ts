import * as vscode from 'vscode';
import { parseSTF, serializeSTF, STFData, StringEntry } from './stfParser';

export class STFEditorProvider implements vscode.CustomEditorProvider<STFDocument> {
    public static readonly viewType = 'stfEditor.stfFile';

    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<STFDocument>>();
    public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    constructor(private readonly context: vscode.ExtensionContext) {}

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new STFEditorProvider(context);
        return vscode.window.registerCustomEditorProvider(
            STFEditorProvider.viewType,
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
    ): Promise<STFDocument> {
        const data = await vscode.workspace.fs.readFile(uri);
        return new STFDocument(uri, data);
    }

    async resolveCustomEditor(
        document: STFDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true
        };

        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

        // Send initial data to webview
        webviewPanel.webview.postMessage({
            type: 'load',
            data: document.stfData
        });

        // Handle messages from webview
        webviewPanel.webview.onDidReceiveMessage(e => {
            switch (e.type) {
                case 'edit':
                    this.handleEdit(document, e.entries);
                    break;
                case 'ready':
                    webviewPanel.webview.postMessage({
                        type: 'load',
                        data: document.stfData
                    });
                    break;
            }
        });
    }

    private handleEdit(document: STFDocument, entries: StringEntry[]) {
        const oldEntries = [...document.stfData.entries];
        document.stfData.entries = entries;
        document.stfData.nextUid = entries.length + 1;

        this._onDidChangeCustomDocument.fire({
            document,
            undo: () => {
                document.stfData.entries = oldEntries;
            },
            redo: () => {
                document.stfData.entries = entries;
            }
        });
    }

    async saveCustomDocument(document: STFDocument, cancellation: vscode.CancellationToken): Promise<void> {
        const data = serializeSTF(document.stfData);
        await vscode.workspace.fs.writeFile(document.uri, data);
    }

    async saveCustomDocumentAs(document: STFDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
        const data = serializeSTF(document.stfData);
        await vscode.workspace.fs.writeFile(destination, data);
    }

    async revertCustomDocument(document: STFDocument, cancellation: vscode.CancellationToken): Promise<void> {
        const data = await vscode.workspace.fs.readFile(document.uri);
        document.reload(data);
    }

    async backupCustomDocument(document: STFDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        const data = serializeSTF(document.stfData);
        await vscode.workspace.fs.writeFile(context.destination, data);
        return {
            id: context.destination.toString(),
            delete: () => vscode.workspace.fs.delete(context.destination)
        };
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>STF Editor</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 10px;
        }

        .toolbar {
            display: flex;
            gap: 8px;
            margin-bottom: 10px;
            padding: 8px;
            background: var(--vscode-toolbar-background);
            border-radius: 4px;
            flex-wrap: wrap;
        }

        .toolbar button {
            padding: 6px 12px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 13px;
        }

        .toolbar button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .toolbar button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .search-box {
            flex: 1;
            min-width: 150px;
            padding: 6px 10px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
            font-size: 13px;
        }

        .search-box:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }

        .stats {
            padding: 6px 12px;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }

        .pagination {
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .pagination button {
            padding: 4px 8px;
            min-width: 32px;
        }

        .page-info {
            padding: 0 8px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }

        .table-container {
            overflow: auto;
            max-height: calc(100vh - 120px);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            table-layout: fixed;
        }

        th {
            position: sticky;
            top: 0;
            background: var(--vscode-editor-background);
            padding: 10px 12px;
            text-align: left;
            font-weight: 600;
            border-bottom: 2px solid var(--vscode-panel-border);
            z-index: 1;
        }

        th.row-header {
            width: 60px;
        }

        th.key-col {
            width: 30%;
        }

        th.value-col {
            width: calc(70% - 60px);
        }

        td {
            padding: 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            vertical-align: top;
        }

        tr:hover td {
            background: var(--vscode-list-hoverBackground);
        }

        tr.selected td {
            background: var(--vscode-list-activeSelectionBackground);
        }

        .cell-input {
            width: 100%;
            padding: 8px 12px;
            background: transparent;
            color: var(--vscode-foreground);
            border: none;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            resize: none;
            overflow: hidden;
        }

        .cell-input:focus {
            outline: none;
            background: var(--vscode-editor-selectionBackground);
        }

        .cell-input.error {
            background: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-inputValidation-errorForeground);
        }

        .cell-input.id-col {
            font-weight: 500;
        }

        .error-message {
            display: none;
            padding: 8px 12px;
            background: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-inputValidation-errorForeground);
            border-radius: 4px;
            margin-bottom: 10px;
        }

        .error-message.visible {
            display: block;
        }

        .row-number {
            width: 60px;
            text-align: right;
            padding: 8px 8px 8px 12px;
            color: var(--vscode-editorLineNumber-foreground);
            font-size: 12px;
            user-select: none;
        }

        .hidden {
            display: none !important;
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <button id="addBtn" title="Add new entry">+ Add</button>
        <button id="deleteBtn" title="Delete selected entry" disabled>Delete</button>
        <input type="text" class="search-box" id="searchBox" placeholder="Search keys or values...">
        <div class="pagination">
            <button id="firstBtn" title="First page">&laquo;</button>
            <button id="prevBtn" title="Previous page">&lsaquo;</button>
            <span class="page-info" id="pageInfo">1 / 1</span>
            <button id="nextBtn" title="Next page">&rsaquo;</button>
            <button id="lastBtn" title="Last page">&raquo;</button>
        </div>
        <span class="stats" id="stats"></span>
    </div>

    <div class="error-message" id="errorMessage"></div>

    <div class="table-container">
        <table>
            <thead>
                <tr>
                    <th class="row-header">#</th>
                    <th class="key-col">Key (ID)</th>
                    <th class="value-col">Value (String)</th>
                </tr>
            </thead>
            <tbody id="tableBody">
            </tbody>
        </table>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        const PAGE_SIZE = 20;
        let entries = [];
        let filteredIndices = [];
        let currentPage = 0;
        let selectedRow = -1;
        let usedIds = new Set();

        const tableBody = document.getElementById('tableBody');
        const addBtn = document.getElementById('addBtn');
        const deleteBtn = document.getElementById('deleteBtn');
        const searchBox = document.getElementById('searchBox');
        const errorMessage = document.getElementById('errorMessage');
        const stats = document.getElementById('stats');
        const pageInfo = document.getElementById('pageInfo');
        const firstBtn = document.getElementById('firstBtn');
        const prevBtn = document.getElementById('prevBtn');
        const nextBtn = document.getElementById('nextBtn');
        const lastBtn = document.getElementById('lastBtn');

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'load':
                    entries = message.data.entries || [];
                    currentPage = 0;
                    applyFilter();
                    break;
            }
        });

        function applyFilter() {
            usedIds = new Set(entries.map(e => e.id));
            const searchTerm = searchBox.value.toLowerCase();

            filteredIndices = [];
            entries.forEach((entry, index) => {
                const matchesSearch = !searchTerm ||
                    entry.id.toLowerCase().includes(searchTerm) ||
                    entry.value.toLowerCase().includes(searchTerm);
                if (matchesSearch) {
                    filteredIndices.push(index);
                }
            });

            // Reset to first page when filter changes
            currentPage = 0;
            renderPage();
        }

        function renderPage() {
            tableBody.innerHTML = '';

            const totalPages = Math.max(1, Math.ceil(filteredIndices.length / PAGE_SIZE));
            if (currentPage >= totalPages) currentPage = totalPages - 1;
            if (currentPage < 0) currentPage = 0;

            const startIdx = currentPage * PAGE_SIZE;
            const endIdx = Math.min(startIdx + PAGE_SIZE, filteredIndices.length);
            const pageIndices = filteredIndices.slice(startIdx, endIdx);

            pageIndices.forEach((entryIndex) => {
                const entry = entries[entryIndex];
                const tr = document.createElement('tr');
                tr.dataset.index = entryIndex;

                if (entryIndex === selectedRow) {
                    tr.classList.add('selected');
                }

                // Row number
                const tdNum = document.createElement('td');
                tdNum.className = 'row-number';
                tdNum.textContent = (entryIndex + 1).toString();
                tr.appendChild(tdNum);

                // ID column
                const tdId = document.createElement('td');
                const inputId = document.createElement('input');
                inputId.type = 'text';
                inputId.className = 'cell-input id-col';
                inputId.value = entry.id;
                inputId.dataset.index = entryIndex;
                inputId.dataset.field = 'id';
                inputId.addEventListener('input', handleCellEdit);
                inputId.addEventListener('focus', () => selectRow(entryIndex));
                tdId.appendChild(inputId);
                tr.appendChild(tdId);

                // Value column
                const tdValue = document.createElement('td');
                const inputValue = document.createElement('textarea');
                inputValue.className = 'cell-input';
                inputValue.value = entry.value;
                inputValue.rows = 1;
                inputValue.dataset.index = entryIndex;
                inputValue.dataset.field = 'value';
                inputValue.addEventListener('input', handleCellEdit);
                inputValue.addEventListener('focus', () => selectRow(entryIndex));
                inputValue.addEventListener('input', autoResizeTextarea);
                tdValue.appendChild(inputValue);
                tr.appendChild(tdValue);

                tr.addEventListener('click', () => selectRow(entryIndex));
                tableBody.appendChild(tr);

                // Auto-resize textarea on load
                autoResizeTextarea({ target: inputValue });
            });

            updatePagination(totalPages);
            updateStats();
        }

        function updatePagination(totalPages) {
            pageInfo.textContent = (currentPage + 1) + ' / ' + totalPages;
            firstBtn.disabled = currentPage === 0;
            prevBtn.disabled = currentPage === 0;
            nextBtn.disabled = currentPage >= totalPages - 1;
            lastBtn.disabled = currentPage >= totalPages - 1;
        }

        function autoResizeTextarea(e) {
            const textarea = e.target;
            textarea.style.height = 'auto';
            textarea.style.height = textarea.scrollHeight + 'px';
        }

        function handleCellEdit(e) {
            const index = parseInt(e.target.dataset.index);
            const field = e.target.dataset.field;
            const newValue = e.target.value;

            if (field === 'id') {
                const isDuplicate = entries.some((entry, i) =>
                    i !== index && entry.id === newValue
                );

                if (isDuplicate && newValue !== '') {
                    e.target.classList.add('error');
                    showError('Duplicate key: "' + newValue + '" already exists');
                    return;
                } else {
                    e.target.classList.remove('error');
                    hideError();
                }
            }

            entries[index][field] = newValue;
            usedIds = new Set(entries.map(e => e.id));
            notifyChange();
        }

        function selectRow(index) {
            selectedRow = index;
            deleteBtn.disabled = false;

            document.querySelectorAll('tr.selected').forEach(tr => {
                tr.classList.remove('selected');
            });

            const tr = tableBody.querySelector('tr[data-index="' + index + '"]');
            if (tr) {
                tr.classList.add('selected');
            }
        }

        function showError(msg) {
            errorMessage.textContent = msg;
            errorMessage.classList.add('visible');
        }

        function hideError() {
            errorMessage.classList.remove('visible');
        }

        function updateStats() {
            const showing = Math.min(PAGE_SIZE, filteredIndices.length - currentPage * PAGE_SIZE);
            const filtered = filteredIndices.length;
            const total = entries.length;
            if (filtered === total) {
                stats.textContent = total + ' entries';
            } else {
                stats.textContent = filtered + ' of ' + total + ' matched';
            }
        }

        function notifyChange() {
            vscode.postMessage({
                type: 'edit',
                entries: entries
            });
        }

        // Pagination controls
        firstBtn.addEventListener('click', () => { currentPage = 0; renderPage(); });
        prevBtn.addEventListener('click', () => { currentPage--; renderPage(); });
        nextBtn.addEventListener('click', () => { currentPage++; renderPage(); });
        lastBtn.addEventListener('click', () => {
            currentPage = Math.ceil(filteredIndices.length / PAGE_SIZE) - 1;
            renderPage();
        });

        // Add new entry
        addBtn.addEventListener('click', () => {
            let newId = 'new_entry';
            let counter = 1;
            while (usedIds.has(newId)) {
                newId = 'new_entry_' + counter;
                counter++;
            }

            entries.push({ id: newId, value: '' });
            // Go to last page to see new entry
            searchBox.value = '';
            applyFilter();
            currentPage = Math.ceil(filteredIndices.length / PAGE_SIZE) - 1;
            renderPage();
            notifyChange();

            // Focus the new row's ID field
            setTimeout(() => {
                const lastInput = tableBody.querySelector('tr:last-child input[data-field="id"]');
                if (lastInput) {
                    lastInput.focus();
                    lastInput.select();
                }
            }, 0);
        });

        // Delete selected entry
        deleteBtn.addEventListener('click', () => {
            if (selectedRow >= 0 && selectedRow < entries.length) {
                entries.splice(selectedRow, 1);
                selectedRow = -1;
                deleteBtn.disabled = true;
                applyFilter();
                notifyChange();
            }
        });

        // Search
        searchBox.addEventListener('input', () => {
            applyFilter();
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Delete' && e.ctrlKey && selectedRow >= 0) {
                deleteBtn.click();
            }
            if (e.key === 'n' && e.ctrlKey) {
                e.preventDefault();
                addBtn.click();
            }
            // Page navigation
            if (e.key === 'ArrowLeft' && e.altKey) {
                e.preventDefault();
                if (!prevBtn.disabled) prevBtn.click();
            }
            if (e.key === 'ArrowRight' && e.altKey) {
                e.preventDefault();
                if (!nextBtn.disabled) nextBtn.click();
            }
        });

        // Tell extension we're ready
        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
    }
}

class STFDocument implements vscode.CustomDocument {
    public stfData: STFData;

    constructor(
        public readonly uri: vscode.Uri,
        initialData: Uint8Array
    ) {
        this.stfData = parseSTF(initialData);
    }

    public reload(data: Uint8Array): void {
        this.stfData = parseSTF(data);
    }

    public dispose(): void {
        // Nothing to dispose
    }
}
