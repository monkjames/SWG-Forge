# SWG CRC Table Editor for VS Code

A Visual Studio Code extension for editing Star Wars Galaxies CRC string table files (`*crc_string_table.iff`).

## Features

- **Search**: Quickly search through 30,000+ entries by path
- **Add Entries**: Add new paths with automatic CRC generation
- **Live CRC Preview**: See the calculated CRC as you type
- **Delete Entries**: Remove entries with confirmation
- **Optimized for Large Files**: Only loads search results, not all entries

## How CRC Works

SWG uses CRC-32 to create unique identifiers for object template paths:
- Paths are normalized to lowercase with forward slashes
- Standard CRC-32 polynomial (0xEDB88320)
- Result is displayed as 8-character hex

Example:
- Path: `object/tangible/food/crafted/dish_grenade.iff`
- CRC: `A1B2C3D4` (example)

## Installation

### Prerequisites

- Node.js (v16+)
- VS Code (v1.74.0+)

### Local Installation

```bash
git clone <repository-url>
cd vscode-crc-editor
npm install
npm run compile
mkdir -p ~/.vscode/extensions/swgemu.crc-editor-1.0.0
cp -r out package.json ~/.vscode/extensions/swgemu.crc-editor-1.0.0/
```

### Remote SSH Installation

```bash
# On the remote server
cd ~/workspace
git clone <repository-url>
cd vscode-crc-editor
npm install
npm run compile
mkdir -p ~/.vscode-server/extensions/swgemu.crc-editor-1.0.0
cp -r out package.json ~/.vscode-server/extensions/swgemu.crc-editor-1.0.0/
```

Reload VS Code after installation.

## Usage

1. Open any `*crc_string_table.iff` file
2. The editor shows:
   - **Add New Entry**: Type a path to see its CRC, click Add to insert
   - **Search Entries**: Search by path substring, results limited to 100
3. Click **Save File** to write changes

## File Format

CRC string table IFF structure:
```
FORM CSTB
  DATA
    - uint32: entry count
    - For each entry:
      - uint32: CRC value
      - uint32: string length
      - char[]: path string (null-terminated)
```

## Development

```bash
npm install
npm run compile   # Build once
npm run watch     # Build on changes
```

Press F5 in VS Code to launch Extension Development Host.

## License

MIT
