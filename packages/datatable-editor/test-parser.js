// Test the datatable parser with both command_table.iff and skills.iff
const fs = require('fs');
const { parseDatatable, serializeDatatable, getColumnInfo } = require('./out/datatableParser');

function testFile(filepath) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Testing: ${filepath}`);
    console.log('='.repeat(60));

    const data = fs.readFileSync(filepath);
    const dt = parseDatatable(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));

    console.log(`Columns: ${dt.columns.length}`);
    console.log(`Rows: ${dt.rows.length}`);

    // Show first 5 columns
    console.log('\nFirst 5 columns:');
    dt.columns.slice(0, 5).forEach((col, i) => {
        console.log(`  ${i}: ${col.name} (${col.type.kind}) [${col.typeStr}]`);
    });

    // Show first 3 rows (first 3 columns)
    console.log('\nFirst 3 rows (first 3 cols):');
    dt.rows.slice(0, 3).forEach((row, i) => {
        const preview = row.slice(0, 3).map(v => JSON.stringify(v).slice(0, 30));
        console.log(`  Row ${i}: ${preview.join(', ')}`);
    });

    // Round-trip test
    const serialized = serializeDatatable(dt);
    const reparsed = parseDatatable(serialized);

    const sizeMatch = serialized.length === data.length;
    const colsMatch = reparsed.columns.length === dt.columns.length;
    const rowsMatch = reparsed.rows.length === dt.rows.length;

    console.log(`\nRound-trip test:`);
    console.log(`  Original: ${data.length} bytes`);
    console.log(`  Serialized: ${serialized.length} bytes`);
    console.log(`  Size match: ${sizeMatch ? 'YES' : 'NO'}`);
    console.log(`  Columns match: ${colsMatch}`);
    console.log(`  Rows match: ${rowsMatch}`);

    if (sizeMatch && colsMatch && rowsMatch) {
        console.log(`\n  SUCCESS!`);
    } else {
        console.log(`\n  ISSUES FOUND`);
    }
}

// Test command_table.iff
testFile('/home/swgemu/workspace/tre/working/datatables/command/command_table.iff');

// Test skills.iff (more complex)
testFile('/home/swgemu/workspace/tre/working/datatables/skill/skills.iff');
