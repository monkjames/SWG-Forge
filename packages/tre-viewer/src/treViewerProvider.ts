import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseTRE, TREContents } from './treReader';

class TREDocument implements vscode.CustomDocument {
    public contents: TREContents | null = null;
    constructor(public readonly uri: vscode.Uri) {}
    public dispose(): void {}
}

export class TREViewerProvider implements vscode.CustomReadonlyEditorProvider<TREDocument> {
    public static readonly viewType = 'treViewer.treFile';

    constructor(private readonly context: vscode.ExtensionContext) {}

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new TREViewerProvider(context);
        return vscode.window.registerCustomEditorProvider(
            TREViewerProvider.viewType,
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
    ): Promise<TREDocument> {
        return new TREDocument(uri);
    }

    async resolveCustomEditor(
        document: TREDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = { enableScripts: true };

        webviewPanel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'ready') {
                await this.loadTRE(document, webviewPanel);
            } else if (msg.type === 'editFile') {
                await this.handleEditFile(msg.filePath, webviewPanel);
            }
        });

        webviewPanel.webview.html = this.getHtml();
    }

    private async handleEditFile(filePath: string, panel: vscode.WebviewPanel): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }
        const root = workspaceFolders[0].uri.fsPath;

        const config = vscode.workspace.getConfiguration('swgForge.tre');
        const workingDir = config.get<string>('workingPath', 'tre/working');
        const infinityDir = config.get<string>('referencePath', 'tre/infinity');
        const vanillaDir = config.get<string>('vanillaPath', 'tre/vanilla');

        const workingPath = path.join(root, workingDir, filePath);
        const infinityPath = path.join(root, infinityDir, filePath);
        const vanillaPath = path.join(root, vanillaDir, filePath);

        // Priority: working (open directly) → infinity (copy to working) → vanilla (copy to working)
        if (fs.existsSync(workingPath)) {
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(workingPath));
            return;
        }

        let sourcePath: string | null = null;
        let sourceLabel: string | null = null;

        if (fs.existsSync(infinityPath)) {
            sourcePath = infinityPath;
            sourceLabel = infinityDir;
        } else if (fs.existsSync(vanillaPath)) {
            sourcePath = vanillaPath;
            sourceLabel = vanillaDir;
        }

        if (sourcePath && sourceLabel) {
            // Copy to working directory, creating parent dirs as needed
            const destDir = path.dirname(workingPath);
            fs.mkdirSync(destDir, { recursive: true });
            fs.copyFileSync(sourcePath, workingPath);
            panel.webview.postMessage({
                type: 'toast',
                message: 'Copied from ' + sourceLabel + '/ to ' + workingDir + '/'
            });
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(workingPath));
        } else {
            vscode.window.showWarningMessage('File not found in working, infinity, or vanilla: ' + filePath);
        }
    }

    private async loadTRE(document: TREDocument, panel: vscode.WebviewPanel): Promise<void> {
        const fileName = path.basename(document.uri.fsPath);

        try {
            document.contents = parseTRE(document.uri.fsPath);
            const c = document.contents;

            const folders = new Set<string>();
            for (const f of c.files) {
                const dir = path.dirname(f.path);
                if (dir !== '.') {
                    folders.add(dir);
                }
            }

            const files = c.files.map(f => ({
                path: f.path,
                uncompressedSize: f.uncompressedSize,
                compressedSize: f.compressedSize,
                compressed: f.compressionType === 2
            }));

            panel.webview.postMessage({
                type: 'data',
                fileName,
                version: c.header.version,
                fileCount: c.header.recordCount,
                folderCount: folders.size,
                archiveSize: c.archiveSize,
                totalUncompressed: c.totalUncompressedSize,
                totalCompressed: c.totalCompressedSize,
                files
            });
        } catch (err: any) {
            panel.webview.postMessage({
                type: 'error',
                message: 'Failed to read TRE file: ' + err.message
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
        lines.push('<title>TRE Viewer</title>');
        lines.push('<style>');
        lines.push('* { box-sizing: border-box; margin: 0; padding: 0; }');
        lines.push('body {');
        lines.push('  font-family: var(--vscode-font-family);');
        lines.push('  font-size: var(--vscode-font-size);');
        lines.push('  color: var(--vscode-foreground);');
        lines.push('  background: var(--vscode-editor-background);');
        lines.push('  padding: 10px;');
        lines.push('}');
        // Header
        lines.push('.header {');
        lines.push('  display: flex; align-items: center; gap: 12px; padding: 8px 12px;');
        lines.push('  background: var(--vscode-toolbar-background); border-radius: 4px;');
        lines.push('  margin-bottom: 8px; flex-wrap: wrap;');
        lines.push('}');
        lines.push('.header .filename { font-weight: 600; font-size: 14px; }');
        lines.push('.header .badge {');
        lines.push('  padding: 2px 8px; border-radius: 10px; font-size: 11px;');
        lines.push('  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);');
        lines.push('}');
        // Search
        lines.push('.search-bar {');
        lines.push('  display: flex; align-items: center; gap: 8px; padding: 6px 0;');
        lines.push('  margin-bottom: 8px;');
        lines.push('}');
        lines.push('.search-bar input {');
        lines.push('  flex: 1; padding: 5px 10px; background: var(--vscode-input-background);');
        lines.push('  color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border);');
        lines.push('  border-radius: 3px; font-size: 12px; font-family: var(--vscode-font-family);');
        lines.push('}');
        lines.push('.search-bar input::placeholder { color: var(--vscode-input-placeholderForeground); }');
        lines.push('.search-bar .match-count {');
        lines.push('  font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap;');
        lines.push('}');
        // Tree container
        lines.push('.tree-container {');
        lines.push('  overflow: auto; max-height: calc(100vh - 120px);');
        lines.push('  border: 1px solid var(--vscode-panel-border); border-radius: 4px;');
        lines.push('}');
        // Tree rows
        lines.push('.tree-row {');
        lines.push('  display: flex; align-items: center; height: 24px;');
        lines.push('  padding: 0 8px; cursor: default; white-space: nowrap;');
        lines.push('  font-family: var(--vscode-editor-font-family); font-size: 12px;');
        lines.push('  border-bottom: 1px solid var(--vscode-panel-border, transparent);');
        lines.push('}');
        lines.push('.tree-row:hover { background: var(--vscode-list-hoverBackground); }');
        lines.push('.tree-row.folder { cursor: pointer; }');
        // Arrow toggle
        lines.push('.arrow {');
        lines.push('  width: 16px; height: 16px; display: inline-flex;');
        lines.push('  align-items: center; justify-content: center;');
        lines.push('  font-size: 10px; flex-shrink: 0;');
        lines.push('  color: var(--vscode-foreground);');
        lines.push('}');
        lines.push('.arrow.collapsed::before { content: "\\25B6"; }');
        lines.push('.arrow.expanded::before { content: "\\25BC"; }');
        lines.push('.arrow.spacer::before { content: ""; }');
        // Name column
        lines.push('.row-name {');
        lines.push('  flex: 1; overflow: hidden; text-overflow: ellipsis;');
        lines.push('  display: flex; align-items: center; gap: 4px;');
        lines.push('}');
        lines.push('.folder-name { color: var(--vscode-foreground); font-weight: 500; }');
        lines.push('.file-name { color: var(--vscode-foreground); }');
        lines.push('.file-count {');
        lines.push('  color: var(--vscode-descriptionForeground); font-size: 11px;');
        lines.push('  margin-left: 6px;');
        lines.push('}');
        // Stat columns
        lines.push('.row-stat {');
        lines.push('  width: 90px; text-align: right; flex-shrink: 0;');
        lines.push('  font-size: 11px; color: var(--vscode-descriptionForeground);');
        lines.push('  padding-left: 8px;');
        lines.push('}');
        lines.push('.row-stat.size-col { color: var(--vscode-foreground); }');
        // Edit button
        lines.push('.edit-btn {');
        lines.push('  padding: 1px 6px; font-size: 11px; border: none; border-radius: 3px; cursor: pointer;');
        lines.push('  background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);');
        lines.push('  opacity: 0; flex-shrink: 0; margin-left: 4px;');
        lines.push('}');
        lines.push('.tree-row:hover .edit-btn { opacity: 1; }');
        lines.push('.edit-btn:hover { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }');
        // Toast notification
        lines.push('.toast {');
        lines.push('  position: fixed; bottom: 16px; right: 16px; padding: 8px 16px;');
        lines.push('  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);');
        lines.push('  border-radius: 4px; font-size: 12px; z-index: 100;');
        lines.push('  transition: opacity 0.3s; opacity: 0; pointer-events: none;');
        lines.push('}');
        lines.push('.toast.visible { opacity: 1; }');
        // Loading / error
        lines.push('.loading { padding: 40px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 14px; }');
        lines.push('.error-msg {');
        lines.push('  padding: 12px; background: var(--vscode-inputValidation-errorBackground);');
        lines.push('  color: var(--vscode-inputValidation-errorForeground); border-radius: 4px;');
        lines.push('  margin-bottom: 8px; display: none;');
        lines.push('}');
        lines.push('.error-msg.visible { display: block; }');
        lines.push('</style>');
        lines.push('</head>');
        lines.push('<body>');
        lines.push('<div class="header">');
        lines.push('  <span class="filename" id="treName">Loading...</span>');
        lines.push('  <span class="badge" id="treVersion"></span>');
        lines.push('  <span class="badge" id="treFiles"></span>');
        lines.push('  <span class="badge" id="treFolders"></span>');
        lines.push('  <span class="badge" id="treSize"></span>');
        lines.push('</div>');
        lines.push('<div class="error-msg" id="errorMsg"></div>');
        lines.push('<div class="search-bar">');
        lines.push('  <input type="text" id="searchInput" placeholder="Filter files... (e.g. object/tangible or .iff)">');
        lines.push('  <span class="match-count" id="matchCount"></span>');
        lines.push('</div>');
        lines.push('<div class="tree-container" id="treeContainer">');
        lines.push('  <div class="loading">Loading TRE contents...</div>');
        lines.push('</div>');
        lines.push('<div class="toast" id="toast"></div>');
        // Script
        lines.push('<script>');
        lines.push('(function() {');
        lines.push('var vscodeApi = acquireVsCodeApi();');
        lines.push('var allFiles = [];');
        lines.push('var rootNode = null;');
        lines.push('var expanded = {};');
        lines.push('var isFiltering = false;');
        lines.push('');
        lines.push('var treeContainer = document.getElementById("treeContainer");');
        lines.push('var searchInput = document.getElementById("searchInput");');
        lines.push('var matchCount = document.getElementById("matchCount");');
        lines.push('var errorMsg = document.getElementById("errorMsg");');
        lines.push('');
        // Utility functions
        lines.push('function formatSize(bytes) {');
        lines.push('  if (bytes === 0) return "0 B";');
        lines.push('  if (bytes < 1024) return bytes + " B";');
        lines.push('  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";');
        lines.push('  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";');
        lines.push('  return (bytes / 1073741824).toFixed(2) + " GB";');
        lines.push('}');
        lines.push('');
        lines.push('function formatRatio(uncompressed, compressed) {');
        lines.push('  if (uncompressed === 0) return "-";');
        lines.push('  return Math.round((1 - compressed / uncompressed) * 100) + "%";');
        lines.push('}');
        lines.push('');
        // Build tree from flat file list
        lines.push('function buildTree(files) {');
        lines.push('  var root = { name: "", fullPath: "", folders: {}, files: [], totalSize: 0, totalCompressed: 0, fileCount: 0 };');
        lines.push('  for (var i = 0; i < files.length; i++) {');
        lines.push('    var f = files[i];');
        lines.push('    var parts = f.path.split("/");');
        lines.push('    var node = root;');
        lines.push('    for (var j = 0; j < parts.length - 1; j++) {');
        lines.push('      var folderName = parts[j];');
        lines.push('      if (!node.folders[folderName]) {');
        lines.push('        var fp = parts.slice(0, j + 1).join("/");');
        lines.push('        node.folders[folderName] = { name: folderName, fullPath: fp, folders: {}, files: [], totalSize: 0, totalCompressed: 0, fileCount: 0 };');
        lines.push('      }');
        lines.push('      node = node.folders[folderName];');
        lines.push('    }');
        lines.push('    node.files.push({ name: parts[parts.length - 1], uncompressedSize: f.uncompressedSize, compressedSize: f.compressedSize, compressed: f.compressed, path: f.path });');
        lines.push('  }');
        lines.push('  computeTotals(root);');
        lines.push('  return root;');
        lines.push('}');
        lines.push('');
        // Recursive total computation
        lines.push('function computeTotals(node) {');
        lines.push('  var totalSize = 0;');
        lines.push('  var totalCompressed = 0;');
        lines.push('  var fileCount = 0;');
        lines.push('  var folderNames = Object.keys(node.folders);');
        lines.push('  for (var i = 0; i < folderNames.length; i++) {');
        lines.push('    var child = node.folders[folderNames[i]];');
        lines.push('    computeTotals(child);');
        lines.push('    totalSize += child.totalSize;');
        lines.push('    totalCompressed += child.totalCompressed;');
        lines.push('    fileCount += child.fileCount;');
        lines.push('  }');
        lines.push('  for (var i = 0; i < node.files.length; i++) {');
        lines.push('    totalSize += node.files[i].uncompressedSize;');
        lines.push('    totalCompressed += node.files[i].compressedSize;');
        lines.push('    fileCount++;');
        lines.push('  }');
        lines.push('  node.totalSize = totalSize;');
        lines.push('  node.totalCompressed = totalCompressed;');
        lines.push('  node.fileCount = fileCount;');
        lines.push('}');
        lines.push('');
        // Collect visible rows by walking the tree
        lines.push('function collectRows(node, depth, rows) {');
        lines.push('  var folderNames = Object.keys(node.folders).sort();');
        lines.push('  var sortedFiles = node.files.slice().sort(function(a, b) { return a.name.localeCompare(b.name); });');
        lines.push('');
        lines.push('  for (var i = 0; i < folderNames.length; i++) {');
        lines.push('    var child = node.folders[folderNames[i]];');
        lines.push('    var isExpanded = !!expanded[child.fullPath];');
        lines.push('    rows.push({ type: "folder", name: child.name, fullPath: child.fullPath, depth: depth, expanded: isExpanded, fileCount: child.fileCount, totalSize: child.totalSize, totalCompressed: child.totalCompressed });');
        lines.push('    if (isExpanded) {');
        lines.push('      collectRows(child, depth + 1, rows);');
        lines.push('    }');
        lines.push('  }');
        lines.push('');
        lines.push('  for (var i = 0; i < sortedFiles.length; i++) {');
        lines.push('    var f = sortedFiles[i];');
        lines.push('    rows.push({ type: "file", name: f.name, path: f.path, depth: depth, uncompressedSize: f.uncompressedSize, compressedSize: f.compressedSize, compressed: f.compressed });');
        lines.push('  }');
        lines.push('}');
        lines.push('');
        // Render the tree
        lines.push('function renderTree() {');
        lines.push('  if (!rootNode) return;');
        lines.push('  var rows = [];');
        lines.push('  collectRows(rootNode, 0, rows);');
        lines.push('');
        lines.push('  var totalFileCount = 0;');
        lines.push('  for (var i = 0; i < rows.length; i++) { if (rows[i].type === "file") totalFileCount++; }');
        lines.push('  matchCount.textContent = isFiltering ? (totalFileCount + " of " + allFiles.length + " files") : (allFiles.length + " files");');
        lines.push('');
        lines.push('  treeContainer.innerHTML = "";');
        lines.push('  if (rows.length === 0) {');
        lines.push('    var msg = document.createElement("div");');
        lines.push('    msg.className = "loading";');
        lines.push('    msg.textContent = isFiltering ? "No files match filter" : "Empty archive";');
        lines.push('    treeContainer.appendChild(msg);');
        lines.push('    return;');
        lines.push('  }');
        lines.push('');
        lines.push('  var frag = document.createDocumentFragment();');
        lines.push('  for (var i = 0; i < rows.length; i++) {');
        lines.push('    var r = rows[i];');
        lines.push('    var row = document.createElement("div");');
        lines.push('    row.className = "tree-row" + (r.type === "folder" ? " folder" : "");');
        lines.push('    row.style.paddingLeft = (8 + r.depth * 20) + "px";');
        lines.push('');
        // Arrow
        lines.push('    var arrow = document.createElement("span");');
        lines.push('    arrow.className = r.type === "folder" ? ("arrow " + (r.expanded ? "expanded" : "collapsed")) : "arrow spacer";');
        lines.push('    row.appendChild(arrow);');
        lines.push('');
        // Name section
        lines.push('    var nameDiv = document.createElement("span");');
        lines.push('    nameDiv.className = "row-name";');
        lines.push('    var nameSpan = document.createElement("span");');
        lines.push('    nameSpan.className = r.type === "folder" ? "folder-name" : "file-name";');
        lines.push('    nameSpan.textContent = r.type === "folder" ? r.name + "/" : r.name;');
        lines.push('    nameDiv.appendChild(nameSpan);');
        lines.push('');
        lines.push('    if (r.type === "folder") {');
        lines.push('      var countSpan = document.createElement("span");');
        lines.push('      countSpan.className = "file-count";');
        lines.push('      countSpan.textContent = r.fileCount + (r.fileCount === 1 ? " file" : " files");');
        lines.push('      nameDiv.appendChild(countSpan);');
        lines.push('    }');
        lines.push('    row.appendChild(nameDiv);');
        lines.push('');
        // Size column
        lines.push('    var sizeDiv = document.createElement("span");');
        lines.push('    sizeDiv.className = "row-stat size-col";');
        lines.push('    sizeDiv.textContent = r.type === "folder" ? formatSize(r.totalSize) : formatSize(r.uncompressedSize);');
        lines.push('    row.appendChild(sizeDiv);');
        lines.push('');
        // Compressed column
        lines.push('    var compDiv = document.createElement("span");');
        lines.push('    compDiv.className = "row-stat";');
        lines.push('    if (r.type === "folder") {');
        lines.push('      compDiv.textContent = formatSize(r.totalCompressed);');
        lines.push('    } else {');
        lines.push('      compDiv.textContent = r.compressed ? formatSize(r.compressedSize) : "-";');
        lines.push('    }');
        lines.push('    row.appendChild(compDiv);');
        lines.push('');
        // Ratio column
        lines.push('    var ratioDiv = document.createElement("span");');
        lines.push('    ratioDiv.className = "row-stat";');
        lines.push('    if (r.type === "folder") {');
        lines.push('      ratioDiv.textContent = formatRatio(r.totalSize, r.totalCompressed);');
        lines.push('    } else {');
        lines.push('      ratioDiv.textContent = r.compressed ? formatRatio(r.uncompressedSize, r.compressedSize) : "-";');
        lines.push('    }');
        lines.push('    row.appendChild(ratioDiv);');
        lines.push('');
        // Edit button for files
        lines.push('    if (r.type === "file") {');
        lines.push('      var editBtn = document.createElement("button");');
        lines.push('      editBtn.className = "edit-btn";');
        lines.push('      editBtn.textContent = "Edit";');
        lines.push('      editBtn.title = "Open in editor (copies to tre/working if needed)";');
        lines.push('      (function(filePath) {');
        lines.push('        editBtn.addEventListener("click", function(e) {');
        lines.push('          e.stopPropagation();');
        lines.push('          vscodeApi.postMessage({ type: "editFile", filePath: filePath });');
        lines.push('        });');
        lines.push('      })(r.path);');
        lines.push('      row.appendChild(editBtn);');
        lines.push('    }');
        lines.push('');
        // Click handler for folders
        lines.push('    if (r.type === "folder") {');
        lines.push('      (function(fullPath) {');
        lines.push('        row.addEventListener("click", function() {');
        lines.push('          if (expanded[fullPath]) { delete expanded[fullPath]; }');
        lines.push('          else { expanded[fullPath] = true; }');
        lines.push('          renderTree();');
        lines.push('        });');
        lines.push('      })(r.fullPath);');
        lines.push('    }');
        lines.push('');
        lines.push('    if (r.type === "file") { row.title = r.path; }');
        lines.push('    frag.appendChild(row);');
        lines.push('  }');
        lines.push('  treeContainer.appendChild(frag);');
        lines.push('}');
        lines.push('');
        // Filter logic
        lines.push('function applyFilter() {');
        lines.push('  var query = searchInput.value.toLowerCase().trim();');
        lines.push('  if (query === "") {');
        lines.push('    isFiltering = false;');
        lines.push('    rootNode = buildTree(allFiles);');
        lines.push('    expanded = {};');
        lines.push('    renderTree();');
        lines.push('    return;');
        lines.push('  }');
        lines.push('  isFiltering = true;');
        lines.push('  var filtered = allFiles.filter(function(f) { return f.path.toLowerCase().indexOf(query) !== -1; });');
        lines.push('  rootNode = buildTree(filtered);');
        // Auto-expand all folders when filtering
        lines.push('  expanded = {};');
        lines.push('  expandAll(rootNode);');
        lines.push('  renderTree();');
        lines.push('}');
        lines.push('');
        lines.push('function expandAll(node) {');
        lines.push('  var folderNames = Object.keys(node.folders);');
        lines.push('  for (var i = 0; i < folderNames.length; i++) {');
        lines.push('    var child = node.folders[folderNames[i]];');
        lines.push('    expanded[child.fullPath] = true;');
        lines.push('    expandAll(child);');
        lines.push('  }');
        lines.push('}');
        lines.push('');
        // Debounced filter input
        lines.push('var filterTimer = null;');
        lines.push('searchInput.addEventListener("input", function() {');
        lines.push('  if (filterTimer) clearTimeout(filterTimer);');
        lines.push('  filterTimer = setTimeout(applyFilter, 150);');
        lines.push('});');
        lines.push('');
        // Message handler
        lines.push('window.addEventListener("message", function(event) {');
        lines.push('  var msg = event.data;');
        lines.push('  if (msg.type === "data") {');
        lines.push('    document.getElementById("treName").textContent = msg.fileName;');
        lines.push('    document.getElementById("treVersion").textContent = "v" + msg.version;');
        lines.push('    document.getElementById("treFiles").textContent = msg.fileCount.toLocaleString() + " files";');
        lines.push('    document.getElementById("treFolders").textContent = msg.folderCount.toLocaleString() + " folders";');
        lines.push('    document.getElementById("treSize").textContent = formatSize(msg.archiveSize) + " archive / " + formatSize(msg.totalUncompressed) + " uncompressed";');
        lines.push('    allFiles = msg.files;');
        lines.push('    isFiltering = false;');
        lines.push('    expanded = {};');
        lines.push('    rootNode = buildTree(allFiles);');
        lines.push('    renderTree();');
        lines.push('  } else if (msg.type === "toast") {');
        lines.push('    var toast = document.getElementById("toast");');
        lines.push('    toast.textContent = msg.message;');
        lines.push('    toast.classList.add("visible");');
        lines.push('    setTimeout(function() { toast.classList.remove("visible"); }, 3000);');
        lines.push('  } else if (msg.type === "error") {');
        lines.push('    errorMsg.textContent = msg.message;');
        lines.push('    errorMsg.classList.add("visible");');
        lines.push('    treeContainer.innerHTML = "";');
        lines.push('  }');
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
