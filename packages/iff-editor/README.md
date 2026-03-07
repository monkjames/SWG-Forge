# SWG IFF Editor for VS Code

A Visual Studio Code extension for editing Star Wars Galaxies IFF (Interchange File Format) files. This extension provides a visual tree-based editor with template support for parsing and editing binary chunk data.

## Features

- **Visual Tree View**: See the full IFF hierarchy (FORM containers, XXXX chunks, etc.)
- **Template-Based Editing**: Define templates to parse binary data into typed fields
- **Template Builder**: Click-to-build templates using type pills (string, byte, bool, int, float, etc.)
- **Per-Property Templates**: Save templates for specific property names - they auto-load when you select that property
- **Type-Aware Inputs**: Each field type has appropriate input controls with validation
- **Live Editing**: Changes are applied immediately to the document
- **SWG-Compatible**: Handles SWG's non-standard IFF format (no padding for odd-sized chunks)

## Supported Data Types

| Type | Description | Input |
|------|-------------|-------|
| `string` | Null-terminated ASCII string | Text input |
| `bool` | Boolean (1 byte) | True/False dropdown |
| `byte` | Unsigned 8-bit integer (0-255) | Number input |
| `short` | Signed 16-bit integer | Number input |
| `ushort` | Unsigned 16-bit integer | Number input |
| `int` | Signed 32-bit integer | Number input |
| `uint` | Unsigned 32-bit integer | Number input |
| `float` | 32-bit floating point | Number input |
| `double` | 64-bit floating point | Number input |

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) (v16 or later)
- [VS Code](https://code.visualstudio.com/) (v1.74.0 or later)
- npm (comes with Node.js)

### Local Installation (Windows/Mac/Linux)

1. **Clone the repository**
   ```bash
   git clone git@github.com:monkjames/vsCode-IFF-Editor.git
   cd vsCode-IFF-Editor
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Compile the extension**
   ```bash
   npm run compile
   ```

4. **Install to VS Code**

   Copy the extension to your VS Code extensions folder:

   **Windows:**
   ```powershell
   xcopy /E /I out "%USERPROFILE%\.vscode\extensions\swgemu.iff-editor-1.0.0\out"
   copy package.json "%USERPROFILE%\.vscode\extensions\swgemu.iff-editor-1.0.0\"
   ```

   **Mac/Linux:**
   ```bash
   mkdir -p ~/.vscode/extensions/swgemu.iff-editor-1.0.0
   cp -r out package.json ~/.vscode/extensions/swgemu.iff-editor-1.0.0/
   ```

5. **Reload VS Code**
   - Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
   - Type "Developer: Reload Window"
   - Press Enter

### Remote SSH Installation

When using VS Code with Remote SSH (connecting to a remote server), extensions run on the **remote machine**. This is ideal for editing IFF files stored on a game server.

1. **Connect to your remote server via SSH in VS Code**
   - Install the "Remote - SSH" extension in VS Code
   - Press `Ctrl+Shift+P` → "Remote-SSH: Connect to Host..."
   - Enter your server details (e.g., `user@192.168.1.100`)

2. **Clone and build on the remote server**
   ```bash
   # On the remote server (via VS Code terminal or SSH)
   cd ~/workspace  # or your preferred directory
   git clone git@github.com:monkjames/vsCode-IFF-Editor.git
   cd vsCode-IFF-Editor
   npm install
   npm run compile
   ```

3. **Install to the remote VS Code server extensions folder**
   ```bash
   mkdir -p ~/.vscode-server/extensions/swgemu.iff-editor-1.0.0
   cp -r out package.json ~/.vscode-server/extensions/swgemu.iff-editor-1.0.0/
   ```

4. **Reload the VS Code window**
   - Press `Ctrl+Shift+P`
   - Type "Developer: Reload Window"
   - Press Enter

### Verify Installation

1. Open any `.iff` file in VS Code
2. The file should open in the IFF Editor instead of as binary
3. You should see the tree view with FORM containers and chunks

## Usage

### Basic Workflow

1. **Open an IFF file** - Click on any `.iff` file in the explorer
2. **Navigate the tree** - Click on FORM nodes to expand/collapse, click on chunks to select
3. **View chunk details** - When you select a chunk (like XXXX), the detail panel opens on the right
4. **Build a template** - Click type pills (string, byte, bool, etc.) to define the data structure
5. **Edit values** - Modify the parsed fields using the input controls
6. **Save** - Click "Save File" button or press `Ctrl+S`

### Template Builder

The template builder lets you define how binary data should be interpreted:

1. **Click type pills** to add fields to your template
2. **Click × on a pill** to remove it from the template
3. **Click "Clear"** to reset the template
4. **Click "Save for this property"** to remember this template for the current property name

Templates are saved in browser localStorage and persist across sessions.

### Example: Editing an Object Name

For a typical SWG object template XXXX chunk containing a string reference:

1. Select the `objectName` XXXX chunk
2. Build template: `string` → `byte` → `byte` → `string` → `byte` → `string`
3. Edit the string values as needed
4. Click "Save File"

## Development

### Project Structure

```
vscode-iff-editor/
├── src/
│   ├── extension.ts       # Extension entry point
│   ├── iffParser.ts       # IFF binary parser and serializer
│   └── iffEditorProvider.ts  # Custom editor provider with webview
├── out/                   # Compiled JavaScript (generated)
├── package.json           # Extension manifest
├── tsconfig.json          # TypeScript configuration
└── README.md
```

### Building

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode (recompile on changes)
npm run watch
```

### Debugging

1. Open the project in VS Code
2. Press `F5` to launch the Extension Development Host
3. Open an IFF file in the new window to test

## Technical Details

### IFF Format

IFF (Interchange File Format) is a binary container format:

- **FORM** - Container with 4-byte tag + 4-byte size (big-endian) + 4-byte form name + children
- **Chunks** - Data blocks with 4-byte tag + 4-byte size (big-endian) + variable data

SWG's IFF implementation differs from standard IFF:
- **No padding** - Standard IFF pads odd-sized chunks to even boundaries; SWG does not
- **XXXX chunks** - Property data with null-terminated name followed by typed value
- **DERV chunks** - Derivation/inheritance path to parent template

### Data Endianness

- **Chunk sizes**: Big-endian (in headers)
- **Data values**: Little-endian (inside chunks)

## Troubleshooting

### Extension not loading
- Ensure the extension is in the correct folder (`~/.vscode/extensions/` for local, `~/.vscode-server/extensions/` for remote)
- Check that both `out/` folder and `package.json` are copied
- Reload the VS Code window

### Changes not saving
- Check the console (`Ctrl+Shift+I` → Console tab) for error messages
- Ensure you have write permissions to the file
- Verify "File written successfully" appears in the console

### Template not parsing correctly
- Ensure your template matches the actual data structure
- Check the hex preview to verify the raw bytes
- Some chunks may have variable-length data that's hard to template

## License

MIT

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request
