// french-ok-file: accented file names and contents, the encoding under test
/**
 * Office previews: what the zip reader and the docx / xlsx / pptx readers make
 * of a file. The archives are built here, byte for byte, so the tests also pin
 * what the reader refuses — an archive that lies about its size, a DTD, a
 * file that is no archive at all.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { readDocx, type DocBlock } from './docx';
import { previewKindFor, rawFileUrl } from './kind';
import { readPptx } from './pptx';
import { MAX_SHEET_ROWS, openXlsx } from './xlsx';
import { PreviewError, Zip } from './zip';
import { makeZip, type Part } from './zip-fixture';

(globalThis as { DOMParser?: unknown }).DOMParser = new JSDOM('').window.DOMParser;

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const paragraphs = (blocks: DocBlock[]) => blocks.flatMap((b) => (b.kind === 'paragraph' ? [b] : []));
const plain = (b: DocBlock) => (b.kind === 'paragraph' ? b.runs.map((r) => r.text).join('') : '');

test('kinds are chosen from the name, and SVG is not one of them', () => {
  assert.equal(previewKindFor('a/b/Report.DOCX'), 'docx');
  assert.equal(previewKindFor('sheet.xlsx'), 'xlsx');
  assert.equal(previewKindFor('deck.pptx'), 'pptx');
  assert.equal(previewKindFor('scan.pdf'), 'pdf');
  assert.equal(previewKindFor('photo.jpeg'), 'image');
  assert.equal(previewKindFor('clip.webm'), 'video');
  for (const name of ['logo.svg', 'page.html', 'notes.md', 'Makefile', '.docx', 'old.doc', 'old.xls']) {
    assert.equal(previewKindFor(name), null, name);
  }
  assert.equal(rawFileUrl('a b', 'x/é y.pdf'), '/api/ui/agents/a%20b/files/raw?path=x%2F%C3%A9%20y.pdf');
  assert.match(rawFileUrl('a', 'x.pdf', true), /&download=1$/);
});

test('the zip reader reads stored and deflated parts', async () => {
  const zip = new Zip(makeZip([
    { name: 'a.txt', data: 'stored', stored: true },
    { name: 'dir/b.txt', data: 'déflaté '.repeat(50) },
  ]));
  assert.deepEqual(zip.names(), ['a.txt', 'dir/b.txt']);
  assert.equal(await zip.text('a.txt'), 'stored');
  assert.equal(await zip.text('dir/b.txt'), 'déflaté '.repeat(50));
  await assert.rejects(zip.text('nope.txt'), PreviewError);
});

test('the zip reader refuses what is not an archive, or lies about its size', async () => {
  assert.throws(() => new Zip(new TextEncoder().encode('%PDF-1.4 not a zip').buffer as ArrayBuffer), PreviewError);
  // 8 MiB of zeros deflate to a few KiB: a part may not inflate past its bound.
  const bomb = new Zip(makeZip([{ name: 'bomb.xml', data: Buffer.alloc(8 * 1024 * 1024) }]));
  await assert.rejects(bomb.bytesOf('bomb.xml', 1024 * 1024), (err: unknown) => err instanceof PreviewError && err.code === 'too_large');
  // An encrypted part is never listed.
  const encrypted = new Zip(makeZip([{ name: 'secret.xml', data: 'x', flags: 1 }]));
  assert.equal(encrypted.has('secret.xml'), false);
});

test('docx: headings by style name, formatting, numbered and bulleted lists, tables', async () => {
  const doc = `<?xml version="1.0"?><w:document ${W}><w:body>
    <w:p><w:pPr><w:pStyle w:val="Titre1"/></w:pPr><w:r><w:t>Quarterly report</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Bold </w:t></w:r><w:r><w:rPr><w:i/><w:b w:val="0"/></w:rPr><w:t>italic</w:t></w:r>
      <w:hyperlink r:id="rId9" xmlns:r="urn:r"><w:r><w:t> link</w:t></w:r></w:hyperlink></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>one</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>two</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>dot</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p>
  </w:body></w:document>`;
  const styles = `<w:styles ${W}><w:style w:styleId="Titre1"><w:name w:val="heading 1"/></w:style></w:styles>`;
  const numbering = `<w:numbering ${W}>
    <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
    <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
    <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
  const preview = await readDocx(new Zip(makeZip([
    { name: 'word/document.xml', data: doc }, { name: 'word/styles.xml', data: styles }, { name: 'word/numbering.xml', data: numbering },
  ])));
  const [title, formatted, one, two, dot, , scriptLine] = preview.blocks;
  assert.equal(title?.kind === 'paragraph' && title.heading, 1);
  assert.equal(plain(title as DocBlock), 'Quarterly report');
  assert.deepEqual(formatted?.kind === 'paragraph' && formatted.runs, [
    { text: 'Bold ', bold: true }, { text: 'italic', italic: true }, { text: ' link' },
  ]);
  assert.deepEqual([one, two, dot].map((b) => b?.kind === 'paragraph' && b.marker), ['1.', '2.', '•']);
  const table = preview.blocks[5];
  assert.equal(table?.kind, 'table');
  assert.deepEqual(table?.kind === 'table' && table.rows.map((row) => row.map((cell) => plain(cell[0] as DocBlock))), [['A1', 'B1']]);
  // Text stays text: markup in a run is data, never a node.
  assert.equal(plain(scriptLine as DocBlock), '<script>alert(1)</script>');
  assert.equal(paragraphs(preview.blocks).length, 6);
  assert.equal(preview.truncated, false);
});

test('docx: a DTD or a non-Word archive is refused', async () => {
  const dtd = `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x "boom">]><w:document ${W}><w:body/></w:document>`;
  await assert.rejects(readDocx(new Zip(makeZip([{ name: 'word/document.xml', data: dtd }]))), PreviewError);
  await assert.rejects(readDocx(new Zip(makeZip([{ name: 'other.xml', data: '<a/>' }]))), PreviewError);
  await assert.rejects(readDocx(new Zip(makeZip([{ name: 'word/document.xml', data: '<w:document' }]))), PreviewError);
});

const X = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function workbook(sheetXml: string[], extra: Part[] = []): Zip {
  return new Zip(makeZip([
    { name: 'xl/workbook.xml', data: `<workbook ${X}><sheets>${sheetXml.map((_, i) => `<sheet name="Sheet ${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<Relationships>${sheetXml.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>` },
    ...sheetXml.map((data, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data })),
    ...extra,
  ]));
}

test('xlsx: shared and inline strings, booleans, dates, gaps, lazy sheets', async () => {
  const sheet1 = `<worksheet ${X}><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>inline</t></is></c><c r="D1" t="b"><v>1</v></c></row>
    <row r="3"><c r="A3"><v>1.5</v></c><c r="B3" s="1"><v>45000</v></c><c r="C3" s="1"><v>45000.5</v></c></row>
  </sheetData></worksheet>`;
  const sheet2 = `<worksheet ${X}><sheetData><row r="1"><c r="A1" t="str"><v>second</v></c></row></sheetData></worksheet>`;
  const book = await openXlsx(workbook([sheet1, sheet2], [
    { name: 'xl/sharedStrings.xml', data: `<sst ${X}><si><t>hello</t></si></sst>` },
    { name: 'xl/styles.xml', data: `<styleSheet ${X}><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>` },
  ]));
  assert.deepEqual(book.sheetNames, ['Sheet 1', 'Sheet 2']);
  const first = await book.load(0);
  assert.deepEqual(first.rows, [['hello', '', 'inline', 'TRUE'], [], ['1.5', '2023-03-15', '2023-03-15 12:00']]);
  assert.equal(first.columns, 4);
  assert.equal(first.truncated, false);
  assert.deepEqual((await book.load(1)).rows, [['second']]);
});

test('xlsx: a huge sheet is cut, and a broken workbook is refused', async () => {
  const rows = Array.from({ length: MAX_SHEET_ROWS + 50 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('');
  const big = await openXlsx(workbook([`<worksheet ${X}><sheetData>${rows}</sheetData></worksheet>`]));
  const loaded = await big.load(0);
  assert.equal(loaded.rows.length, MAX_SHEET_ROWS);
  assert.equal(loaded.truncated, true);
  await assert.rejects(openXlsx(new Zip(makeZip([{ name: 'x.xml', data: '<a/>' }]))), PreviewError);
});

test('pptx: slides in presentation order, title apart, body levels, tables', async () => {
  const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const slide = (title: string, body: string) => `<p:sld ${A}><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:txBody><a:p><a:pPr lvl="1"/><a:r><a:t>${body}</a:t></a:r></a:p><a:p><a:r><a:t>  </a:t></a:r></a:p></p:txBody></p:sp>
    <p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><p:txBody><a:p><a:r><a:t>c1</a:t></a:r></a:p></p:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>
  </p:spTree></p:cSld></p:sld>`;
  const preview = await readPptx(new Zip(makeZip([
    { name: 'ppt/presentation.xml', data: `<p:presentation ${A}><p:sldIdLst><p:sldId id="1" r:id="rId2"/><p:sldId id="2" r:id="rId1"/></p:sldIdLst></p:presentation>` },
    { name: 'ppt/_rels/presentation.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>' },
    { name: 'ppt/slides/slide1.xml', data: slide('First file', 'one') },
    { name: 'ppt/slides/slide2.xml', data: slide('Second file', 'two') },
  ])));
  assert.deepEqual(preview.slides.map((s) => s.title), ['Second file', 'First file']);
  assert.deepEqual(preview.slides[0]?.paragraphs, [{ text: 'two', level: 1 }]);
  assert.deepEqual(preview.slides[0]?.tables, [[['c1']]]);
  assert.equal(preview.truncated, false);
});
