import * as vscode from 'vscode';
import { parseDatatable, serializeDatatable, DatatableData, CellValue, getColumnInfo, ColumnInfo } from './datatableParser';

export class DatatableEditorProvider implements vscode.CustomEditorProvider<DatatableDocument> {
    public static readonly viewType = 'datatableEditor.datatableFile';

    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<DatatableDocument>>();
    public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    constructor(private readonly context: vscode.ExtensionContext) {}

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new DatatableEditorProvider(context);
        return vscode.window.registerCustomEditorProvider(
            DatatableEditorProvider.viewType,
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
    ): Promise<DatatableDocument> {
        const data = await vscode.workspace.fs.readFile(uri);
        return new DatatableDocument(uri, data);
    }

    async resolveCustomEditor(
        document: DatatableDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true
        };

        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

        // Send initial data to webview
        const columnInfos = document.data.columns.map(c => getColumnInfo(c));
        webviewPanel.webview.postMessage({
            type: 'load',
            columns: columnInfos,
            rows: document.data.rows
        });

        // Handle messages from webview
        webviewPanel.webview.onDidReceiveMessage(e => {
            switch (e.type) {
                case 'edit':
                    this.handleEdit(document, e.rows);
                    break;
                case 'ready':
                    const cols = document.data.columns.map(c => getColumnInfo(c));
                    webviewPanel.webview.postMessage({
                        type: 'load',
                        columns: cols,
                        rows: document.data.rows
                    });
                    break;
            }
        });
    }

    private handleEdit(document: DatatableDocument, rows: CellValue[][]) {
        const oldRows = document.data.rows.map(r => [...r]);
        document.data.rows = rows;

        this._onDidChangeCustomDocument.fire({
            document,
            undo: () => {
                document.data.rows = oldRows;
            },
            redo: () => {
                document.data.rows = rows;
            }
        });
    }

    async saveCustomDocument(document: DatatableDocument, cancellation: vscode.CancellationToken): Promise<void> {
        const data = serializeDatatable(document.data);
        await vscode.workspace.fs.writeFile(document.uri, data);
    }

    async saveCustomDocumentAs(document: DatatableDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
        const data = serializeDatatable(document.data);
        await vscode.workspace.fs.writeFile(destination, data);
    }

    async revertCustomDocument(document: DatatableDocument, cancellation: vscode.CancellationToken): Promise<void> {
        const data = await vscode.workspace.fs.readFile(document.uri);
        document.reload(data);
    }

    async backupCustomDocument(document: DatatableDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        const data = serializeDatatable(document.data);
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
    <title>Datatable Editor</title>
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
            overflow: hidden;
        }

        .container {
            display: flex;
            flex-direction: column;
            height: 100vh;
            padding: 8px;
        }

        .toolbar {
            display: flex;
            gap: 8px;
            padding: 8px;
            background: var(--vscode-toolbar-background);
            border-radius: 4px;
            flex-wrap: wrap;
            align-items: center;
            flex-shrink: 0;
        }

        .toolbar button {
            padding: 6px 12px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 13px;
            white-space: nowrap;
        }

        .toolbar button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .toolbar button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .toolbar button.danger {
            background: var(--vscode-inputValidation-errorBackground);
        }

        .search-box {
            flex: 1;
            min-width: 150px;
            max-width: 300px;
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
            white-space: nowrap;
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
            white-space: nowrap;
        }

        .spreadsheet-container {
            flex: 1;
            overflow: auto;
            margin-top: 8px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            position: relative;
        }

        .spreadsheet {
            display: grid;
            position: relative;
        }

        .header-row {
            display: contents;
        }

        .header-cell {
            position: sticky;
            top: 0;
            z-index: 2;
            background: var(--vscode-editorGroupHeader-tabsBackground);
            padding: 8px 12px;
            font-weight: 600;
            border-bottom: 2px solid var(--vscode-panel-border);
            border-right: 1px solid var(--vscode-panel-border);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            min-width: 100px;
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .header-cell.row-header {
            position: sticky;
            left: 0;
            z-index: 3;
            min-width: 50px;
            width: 50px;
            text-align: center;
            justify-content: center;
        }

        .header-cell .col-name {
            font-weight: 600;
        }

        .header-cell .col-type {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            font-weight: normal;
        }

        .data-row {
            display: contents;
        }

        .data-row:hover .cell {
            background: var(--vscode-list-hoverBackground);
        }

        .data-row.selected .cell {
            background: var(--vscode-list-activeSelectionBackground);
        }

        .cell {
            padding: 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            border-right: 1px solid var(--vscode-panel-border);
            min-width: 100px;
            background: var(--vscode-editor-background);
        }

        .cell.row-number {
            position: sticky;
            left: 0;
            z-index: 1;
            min-width: 50px;
            width: 50px;
            text-align: right;
            padding: 8px;
            color: var(--vscode-editorLineNumber-foreground);
            font-size: 12px;
            user-select: none;
            cursor: pointer;
            background: var(--vscode-editorGroupHeader-tabsBackground);
        }

        .cell.row-number:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .cell-input {
            width: 100%;
            height: 100%;
            padding: 8px 12px;
            background: transparent;
            color: var(--vscode-foreground);
            border: none;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
        }

        .cell-input:focus {
            outline: none;
            background: var(--vscode-editor-selectionBackground);
        }

        .cell-input[type="checkbox"] {
            width: 18px;
            height: 18px;
            margin: 8px 12px;
            cursor: pointer;
        }

        select.cell-input {
            cursor: pointer;
            appearance: none;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M2 4l4 4 4-4'/%3E%3C/svg%3E");
            background-repeat: no-repeat;
            background-position: right 8px center;
            padding-right: 24px;
        }

        .cell-input.number {
            text-align: right;
        }

        .error-message {
            display: none;
            padding: 8px 12px;
            background: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-inputValidation-errorForeground);
            border-radius: 4px;
            margin-top: 8px;
            flex-shrink: 0;
        }

        .error-message.visible {
            display: block;
        }

        .loading {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: var(--vscode-descriptionForeground);
        }

        .resize-handle {
            position: absolute;
            right: 0;
            top: 0;
            bottom: 0;
            width: 4px;
            cursor: col-resize;
            background: transparent;
        }

        .resize-handle:hover {
            background: var(--vscode-focusBorder);
        }

        /* Column width classes */
        .col-string { min-width: 150px; }
        .col-int, .col-short, .col-float { min-width: 80px; }
        .col-bool { min-width: 60px; }
        .col-enum { min-width: 120px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="toolbar">
            <button id="addRowBtn" title="Add new row (Ctrl+N)">+ Add Row</button>
            <button id="deleteRowBtn" class="danger" title="Delete selected row (Ctrl+Delete)" disabled>Delete Row</button>
            <button id="duplicateRowBtn" title="Duplicate selected row" disabled>Duplicate</button>
            <input type="text" class="search-box" id="searchBox" placeholder="Search all columns...">
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

        <div class="spreadsheet-container" id="spreadsheetContainer">
            <div class="loading" id="loadingIndicator">Loading datatable...</div>
            <div class="spreadsheet" id="spreadsheet" style="display: none;"></div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        const PAGE_SIZE = 50;
        let columns = [];
        let rows = [];
        let filteredIndices = [];
        let currentPage = 0;
        let selectedRowIndex = -1;

        const spreadsheet = document.getElementById('spreadsheet');
        const loadingIndicator = document.getElementById('loadingIndicator');
        const addRowBtn = document.getElementById('addRowBtn');
        const deleteRowBtn = document.getElementById('deleteRowBtn');
        const duplicateRowBtn = document.getElementById('duplicateRowBtn');
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
                    columns = message.columns || [];
                    rows = message.rows || [];
                    currentPage = 0;
                    selectedRowIndex = -1;
                    loadingIndicator.style.display = 'none';
                    spreadsheet.style.display = 'grid';
                    applyFilter();
                    break;
            }
        });

        function applyFilter() {
            const searchTerm = searchBox.value.toLowerCase();

            filteredIndices = [];
            rows.forEach((row, index) => {
                if (!searchTerm) {
                    filteredIndices.push(index);
                    return;
                }
                const matches = row.some(cell => {
                    const cellStr = String(cell).toLowerCase();
                    return cellStr.includes(searchTerm);
                });
                if (matches) {
                    filteredIndices.push(index);
                }
            });

            currentPage = 0;
            renderSpreadsheet();
        }

        function renderSpreadsheet() {
            spreadsheet.innerHTML = '';

            // Set grid columns: row number + all data columns
            const gridCols = ['50px'].concat(columns.map(col => {
                switch (col.kind) {
                    case 'string': return 'minmax(150px, 1fr)';
                    case 'bool': return '80px';
                    case 'int':
                    case 'uint':
                    case 'float': return '100px';
                    case 'enum': return 'minmax(120px, auto)';
                    default: return 'minmax(100px, 1fr)';
                }
            }));
            spreadsheet.style.gridTemplateColumns = gridCols.join(' ');

            // Render header
            const headerRow = document.createElement('div');
            headerRow.className = 'header-row';

            // Row number header
            const rowHeader = document.createElement('div');
            rowHeader.className = 'header-cell row-header';
            rowHeader.innerHTML = '<span class="col-name">#</span>';
            headerRow.appendChild(rowHeader);

            // Column headers
            columns.forEach((col, colIndex) => {
                const header = document.createElement('div');
                header.className = 'header-cell';
                header.innerHTML = '<span class="col-name">' + escapeHtml(col.name) + '</span>' +
                                   '<span class="col-type">' + escapeHtml(col.kind) + '</span>';
                header.title = col.name + ' (' + col.typeStr + ')';
                headerRow.appendChild(header);
            });
            spreadsheet.appendChild(headerRow);

            // Calculate pagination
            const totalPages = Math.max(1, Math.ceil(filteredIndices.length / PAGE_SIZE));
            if (currentPage >= totalPages) currentPage = totalPages - 1;
            if (currentPage < 0) currentPage = 0;

            const startIdx = currentPage * PAGE_SIZE;
            const endIdx = Math.min(startIdx + PAGE_SIZE, filteredIndices.length);
            const pageIndices = filteredIndices.slice(startIdx, endIdx);

            // Render data rows
            pageIndices.forEach(rowIndex => {
                const row = rows[rowIndex];
                const dataRow = document.createElement('div');
                dataRow.className = 'data-row';
                dataRow.dataset.rowIndex = rowIndex;

                if (rowIndex === selectedRowIndex) {
                    dataRow.classList.add('selected');
                }

                // Row number cell
                const rowNumCell = document.createElement('div');
                rowNumCell.className = 'cell row-number';
                rowNumCell.textContent = (rowIndex + 1).toString();
                rowNumCell.addEventListener('click', () => selectRow(rowIndex));
                dataRow.appendChild(rowNumCell);

                // Data cells
                columns.forEach((col, colIndex) => {
                    const cell = document.createElement('div');
                    cell.className = 'cell col-' + col.kind;

                    const input = createInput(col, row[colIndex], rowIndex, colIndex);
                    cell.appendChild(input);
                    dataRow.appendChild(cell);
                });

                spreadsheet.appendChild(dataRow);
            });

            updatePagination(totalPages);
            updateStats();
            updateButtons();
        }

        function createInput(col, value, rowIndex, colIndex) {
            let input;

            switch (col.kind) {
                case 'bool':
                    input = document.createElement('input');
                    input.type = 'checkbox';
                    input.checked = !!value;
                    input.addEventListener('change', () => {
                        updateCell(rowIndex, colIndex, input.checked);
                    });
                    break;

                case 'enum':
                    input = document.createElement('select');
                    (col.enumValues || []).forEach(opt => {
                        const option = document.createElement('option');
                        option.value = opt;
                        option.textContent = opt;
                        if (opt === value) option.selected = true;
                        input.appendChild(option);
                    });
                    input.addEventListener('change', () => {
                        updateCell(rowIndex, colIndex, input.value);
                    });
                    break;

                case 'int':
                case 'uint':
                    input = document.createElement('input');
                    input.type = 'number';
                    input.step = '1';
                    input.value = value;
                    input.className = 'cell-input number';
                    input.addEventListener('change', () => {
                        const num = parseInt(input.value, 10) || 0;
                        updateCell(rowIndex, colIndex, num);
                    });
                    break;

                case 'float':
                    input = document.createElement('input');
                    input.type = 'number';
                    input.step = 'any';
                    input.value = value;
                    input.className = 'cell-input number';
                    input.addEventListener('change', () => {
                        const num = parseFloat(input.value) || 0;
                        updateCell(rowIndex, colIndex, num);
                    });
                    break;

                case 'string':
                default:
                    input = document.createElement('input');
                    input.type = 'text';
                    input.value = value || '';
                    input.addEventListener('input', () => {
                        updateCell(rowIndex, colIndex, input.value);
                    });
                    break;
            }

            if (input.tagName !== 'SELECT') {
                input.className = (input.className || '') + ' cell-input';
            } else {
                input.className = 'cell-input';
            }

            input.addEventListener('focus', () => selectRow(rowIndex));

            return input;
        }

        function updateCell(rowIndex, colIndex, value) {
            rows[rowIndex][colIndex] = value;
            notifyChange();
        }

        function selectRow(index) {
            selectedRowIndex = index;
            updateButtons();

            document.querySelectorAll('.data-row.selected').forEach(el => {
                el.classList.remove('selected');
            });

            const row = document.querySelector('.data-row[data-row-index="' + index + '"]');
            if (row) {
                row.classList.add('selected');
            }
        }

        function updateButtons() {
            const hasSelection = selectedRowIndex >= 0 && selectedRowIndex < rows.length;
            deleteRowBtn.disabled = !hasSelection;
            duplicateRowBtn.disabled = !hasSelection;
        }

        function updatePagination(totalPages) {
            pageInfo.textContent = (currentPage + 1) + ' / ' + totalPages;
            firstBtn.disabled = currentPage === 0;
            prevBtn.disabled = currentPage === 0;
            nextBtn.disabled = currentPage >= totalPages - 1;
            lastBtn.disabled = currentPage >= totalPages - 1;
        }

        function updateStats() {
            const showing = Math.min(PAGE_SIZE, filteredIndices.length - currentPage * PAGE_SIZE);
            const filtered = filteredIndices.length;
            const total = rows.length;
            if (filtered === total) {
                stats.textContent = columns.length + ' cols x ' + total + ' rows';
            } else {
                stats.textContent = filtered + ' of ' + total + ' rows matched';
            }
        }

        function showError(msg) {
            errorMessage.textContent = msg;
            errorMessage.classList.add('visible');
        }

        function hideError() {
            errorMessage.classList.remove('visible');
        }

        function notifyChange() {
            vscode.postMessage({
                type: 'edit',
                rows: rows
            });
        }

        function getDefaultRow() {
            return columns.map(col => {
                switch (col.kind) {
                    case 'string': return '';
                    case 'int':
                    case 'uint': return col.defaultValue || 0;
                    case 'float': return col.defaultValue || 0.0;
                    case 'bool': return col.defaultValue || false;
                    case 'enum': return col.defaultValue || (col.enumValues ? col.enumValues[0] : '');
                    default: return '';
                }
            });
        }

        function escapeHtml(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        // Event handlers
        addRowBtn.addEventListener('click', () => {
            const newRow = getDefaultRow();
            rows.push(newRow);
            searchBox.value = '';
            applyFilter();
            // Go to last page
            const totalPages = Math.ceil(filteredIndices.length / PAGE_SIZE);
            currentPage = totalPages - 1;
            renderSpreadsheet();
            notifyChange();

            // Select and focus the new row
            selectedRowIndex = rows.length - 1;
            setTimeout(() => {
                const lastRow = spreadsheet.querySelector('.data-row:last-of-type');
                if (lastRow) {
                    lastRow.classList.add('selected');
                    const firstInput = lastRow.querySelector('.cell-input');
                    if (firstInput) firstInput.focus();
                }
            }, 0);
        });

        deleteRowBtn.addEventListener('click', () => {
            if (selectedRowIndex >= 0 && selectedRowIndex < rows.length) {
                rows.splice(selectedRowIndex, 1);
                selectedRowIndex = -1;
                applyFilter();
                notifyChange();
            }
        });

        duplicateRowBtn.addEventListener('click', () => {
            if (selectedRowIndex >= 0 && selectedRowIndex < rows.length) {
                const newRow = [...rows[selectedRowIndex]];
                rows.splice(selectedRowIndex + 1, 0, newRow);
                applyFilter();
                notifyChange();
            }
        });

        searchBox.addEventListener('input', () => {
            applyFilter();
        });

        firstBtn.addEventListener('click', () => { currentPage = 0; renderSpreadsheet(); });
        prevBtn.addEventListener('click', () => { currentPage--; renderSpreadsheet(); });
        nextBtn.addEventListener('click', () => { currentPage++; renderSpreadsheet(); });
        lastBtn.addEventListener('click', () => {
            currentPage = Math.ceil(filteredIndices.length / PAGE_SIZE) - 1;
            renderSpreadsheet();
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Delete' && e.ctrlKey && selectedRowIndex >= 0) {
                e.preventDefault();
                deleteRowBtn.click();
            }
            if (e.key === 'n' && e.ctrlKey) {
                e.preventDefault();
                addRowBtn.click();
            }
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

class DatatableDocument implements vscode.CustomDocument {
    public data: DatatableData;

    constructor(
        public readonly uri: vscode.Uri,
        initialData: Uint8Array
    ) {
        this.data = parseDatatable(initialData);
    }

    public reload(data: Uint8Array): void {
        this.data = parseDatatable(data);
    }

    public dispose(): void {
        // Nothing to dispose
    }
}
