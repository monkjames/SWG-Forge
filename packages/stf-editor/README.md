# SWG STF Editor for VS Code

A Visual Studio Code extension for editing Star Wars Galaxies String Table Files (.stf). Provides an Excel-like two-column editor for managing game string translations and text content.

## About

STF (String Table File) is a binary format used by Star Wars Galaxies to store localized strings. Each entry consists of:
- **Key (ID)**: A unique ASCII identifier used to reference the string in code
- **Value**: The actual text content (supports Unicode via UTF-16LE encoding)

This extension replaces the need for external hex editors or command-line tools by providing a native VS Code editing experience with validation, search, and full undo/redo support.

## Features

| Feature | Description |
|---------|-------------|
| Visual Editor | Two-column table with editable Key and Value fields |
| Pagination | Shows 20 entries per page for fast loading of large files |
| Unique Key Validation | Real-time duplicate detection with error highlighting |
| Search & Filter | Filter entries by key or value text |
| Add/Delete Rows | Toolbar buttons and keyboard shortcuts |
| Undo/Redo | Full integration with VS Code's edit history |
| Theme Support | Automatically matches your VS Code color theme |

## Installation

### Prerequisites

- **Node.js 16+** (check with `node --version`)
- **VS Code 1.74+**

### Step 1: Clone and Build

```bash
git clone https://github.com/monkjames/vsCode-sft-editor.git
cd vsCode-sft-editor
npm install
npm run compile
```

### Step 2: Install the Extension

Choose the method based on your setup:

---

#### Local Development (VS Code on your machine)

Copy to your VS Code extensions folder:

```bash
# Linux/macOS
mkdir -p ~/.vscode/extensions/swgemu.stf-editor-1.0.0
cp package.json ~/.vscode/extensions/swgemu.stf-editor-1.0.0/
cp -r out ~/.vscode/extensions/swgemu.stf-editor-1.0.0/

# Windows (PowerShell)
mkdir "$env:USERPROFILE\.vscode\extensions\swgemu.stf-editor-1.0.0"
copy package.json "$env:USERPROFILE\.vscode\extensions\swgemu.stf-editor-1.0.0\"
xcopy out "$env:USERPROFILE\.vscode\extensions\swgemu.stf-editor-1.0.0\out\" /E
```

Then restart VS Code.

---

#### Remote SSH Development (VS Code connecting to a server)

If you're using VS Code's **Remote - SSH** extension to connect to a Linux server, extensions need to be installed on the server side:

```bash
# On the remote server
mkdir -p ~/.vscode-server/extensions/swgemu.stf-editor-1.0.0
cp package.json ~/.vscode-server/extensions/swgemu.stf-editor-1.0.0/
cp -r out ~/.vscode-server/extensions/swgemu.stf-editor-1.0.0/
```

Then in VS Code, press `Ctrl+Shift+P` and run **"Reload Window"**.

---

#### Development/Testing Mode

To test changes without installing:

1. Open the `vsCode-sft-editor` folder in VS Code
2. Press `F5` to launch the Extension Development Host
3. In the new window, open any `.stf` file

## Usage

### Opening STF Files

Simply open any `.stf` file in VS Code. The extension automatically activates and displays the visual editor.

### Editing Entries

- **Edit Key**: Click on any key cell and type. Keys must be unique - duplicates are highlighted in red.
- **Edit Value**: Click on any value cell and type.

### Toolbar

| Control | Action |
|---------|--------|
| **+ Add** | Adds a new entry at the end |
| **Delete** | Removes the selected row |
| **Search box** | Filters entries by key or value |
| **« ‹ › »** | Page navigation (20 entries per page) |

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` | Save file |
| `Ctrl+N` | Add new entry |
| `Ctrl+Delete` | Delete selected entry |
| `Alt+Left` | Previous page |
| `Alt+Right` | Next page |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |

### Workflow Example

1. Open `string/en/item_n.stf` in VS Code
2. Use the search box to find entries containing "sword"
3. Click on a value cell to edit the item name
4. Press `Ctrl+S` to save changes back to the binary STF format

## File Format Reference

STF files use a binary format (little-endian):

```
Header:
  - Magic: 0xABCD (2 bytes)
  - Padding: 2 bytes
  - Version: 1 byte
  - NextUID: 4 bytes
  - NumStrings: 4 bytes

Value Section (repeated NumStrings times):
  - Index: 4 bytes
  - Key: 4 bytes (0xFFFFFFFF)
  - StringLen: 4 bytes
  - Value: StringLen * 2 bytes (UTF-16LE)

ID Section (repeated NumStrings times):
  - Index: 4 bytes
  - IDLen: 4 bytes
  - ID: IDLen bytes (ASCII)
```

## Project Structure

```
vsCode-sft-editor/
├── src/
│   ├── extension.ts         # Extension entry point
│   ├── stfEditorProvider.ts # Custom editor + webview UI
│   └── stfParser.ts         # Binary STF parser/serializer
├── out/                     # Compiled JavaScript (after npm run compile)
├── package.json             # Extension manifest
└── tsconfig.json            # TypeScript configuration
```

## Development

### Building

```bash
npm run compile    # One-time build
npm run watch      # Watch mode for development
```

### Debugging

1. Open the extension folder in VS Code
2. Press `F5` to launch the Extension Development Host
3. Set breakpoints in the TypeScript source files

## Troubleshooting

**Extension not appearing?**
- Make sure you copied both `package.json` and the `out/` folder
- Folder name must be exactly `swgemu.stf-editor-1.0.0`
- For Remote SSH, use `~/.vscode-server/extensions/` not `~/.vscode/extensions/`
- Reload the VS Code window after installing

**Build errors?**
- Ensure Node.js 16+ is installed: `node --version`
- Delete `node_modules` and run `npm install` again

## License

MIT

## Acknowledgments

- SWGEmu community for STF format documentation
- Built for the Infinity server project
