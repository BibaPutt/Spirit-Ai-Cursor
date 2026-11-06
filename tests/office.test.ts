import { describe, expect, it } from 'vitest';
import {
  buildEditDocxComPs,
  buildFfmpegProbe,
  buildPdfToolProbe,
  buildReadDocxPs,
  buildReadPdfPs,
  buildReadXlsxPs,
  buildZipCompressPs,
  buildZipListPs,
  docxXmlToText,
  hasComApp,
  xlsxSheetToText,
} from '../electron/files/office';

const DOCX_XML = [
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
  '<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t> world</w:t></w:r></w:p>',
  '<w:p><w:r><w:t>Second &amp; line</w:t></w:r></w:p>',
  '</w:body></w:document>',
].join('');

const SS_XML = [
  '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
  '<si><t>Name</t></si><si><t>Score</t></si></sst>',
].join('');

const SHEET_XML = [
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>',
  '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>42</v></c></row>',
  '</sheetData></worksheet>',
].join('');

describe('docxXmlToText', () => {
  it('joins runs into paragraphs and decodes entities', () => {
    expect(docxXmlToText(DOCX_XML)).toBe('Hello world\nSecond & line');
  });

  it('caps long documents', () => {
    expect(docxXmlToText('<w:p><w:r><w:t>' + 'x'.repeat(30000) + '</w:t></w:r></w:p>', 100)).toHaveLength(100);
  });
});

describe('xlsxSheetToText', () => {
  it('resolves shared strings and inline values into TSV rows', () => {
    expect(xlsxSheetToText(SS_XML, SHEET_XML)).toBe('Name\tScore\nScore\t42');
  });

  it('caps rows', () => {
    const many = SHEET_XML.replace('</sheetData>', '<row r="3"><c r="A3"><v>1</v></c></row></sheetData>');
    expect(xlsxSheetToText(SS_XML, many, 2).split('\n')).toHaveLength(2);
  });
});

describe('script builders', () => {
  it('quote paths and name the right parts', () => {
    expect(buildReadDocxPs('C:\\a\\b.docx')).toContain('word/document.xml');
    expect(buildReadXlsxPs('C:\\a\\b.xlsx')).toContain('xl/worksheets');
    expect(buildReadPdfPs('C:\\a\\b.pdf')).toContain('pdftotext');
    expect(buildPdfToolProbe()).toContain('pdftotext');
    expect(buildFfmpegProbe()).toContain('ffmpeg');
    expect(buildZipCompressPs('C:\\a', 'C:\\a.zip')).toContain('Compress-Archive');
    expect(buildZipListPs('C:\\a.zip')).toContain('Entries');
    expect(buildEditDocxComPs('C:\\a.docx', 'x', 'y')).toContain('Word.Application');
  });

  it('hasComApp is false when COM is missing', async () => {
    const ok = await hasComApp('Word.Application', async () => {
      throw new Error('nope');
    });
    expect(ok).toBe(false);
  });
});
