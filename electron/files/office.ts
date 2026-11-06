import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export type PsRunner = (script: string) => Promise<{ stdout: string; stderr: string }>;

export const defaultPsRunner: PsRunner = async (script: string) => {
  if (process.platform !== 'win32') throw new Error('PowerShell helpers need Windows.');
  const { stdout, stderr } = await execFileP(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: 30_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  return { stdout, stderr };
};

// Registry probe for a COM server (Word.Application / Excel.Application).
// No app launch — just checks the class is registered.
export function buildComProbe(progId: 'Word.Application' | 'Excel.Application'): string {
  return (
    `if (Get-ItemProperty -Path 'HKCR:\\${progId}\\CLSID' -ErrorAction SilentlyContinue) { 'yes' } ` +
    `else { 'no' }`
  );
}

export async function hasComApp(
  progId: 'Word.Application' | 'Excel.Application',
  run: PsRunner = defaultPsRunner,
): Promise<boolean> {
  try {
    const { stdout } = await run(buildComProbe(progId));
    return stdout.trim().toLowerCase().startsWith('yes');
  } catch {
    return false;
  }
}

// Read a .docx without Office: unzip word/document.xml, strip tags.
// Pure (unit-tested); the unzip step is Expand-Archive in the script below.
export function docxXmlToText(xml: string, maxChars = 20000): string {
  const paras = xml
    .split(/<\/w:p\s*>/i)
    .map((p) =>
      p
        .replace(/<w:tab\s*\/>/gi, '\t')
        .replace(/<w:br\s*\/>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&(lt|gt|amp|quot|apos);/g, (m) =>
          m === '&lt;' ? '<' : m === '&gt;' ? '>' : m === '&amp;' ? '&' : m === '&quot;' ? '"' : "'",
        )
        .trim(),
    )
    .filter(Boolean);
  const text = paras.join('\n');
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

// Read an .xlsx sheet without Office: shared-strings resolve + row join.
// Pure (unit-tested). Namespaces are matched by local name so prefix drift
// across producers (a1/x14ac, strict/transitional) doesn't matter.
export function xlsxSheetToText(
  sharedStringsXml: string,
  sheetXml: string,
  maxRows = 200,
  maxChars = 20000,
): string {
  const strings: string[] = [];
  const ssRe = /<(?:\w+:)?t[^>]*>([^<]*)<\/(?:\w+:)?t>/g;
  let m: RegExpExecArray | null;
  while ((m = ssRe.exec(sharedStringsXml)) !== null) strings.push(m[1]);
  const rows: string[] = [];
  const rowRe = /<(?:\w+:)?row[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g;
  let r: RegExpExecArray | null;
  while ((r = rowRe.exec(sheetXml)) !== null && rows.length < maxRows) {
    const cells: string[] = [];
    const cellRe = /<(?:\w+:)?c(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?c>/g;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(r[1])) !== null) {
      const body = c[1];
      if (/\st="s"/.test(c[0])) {
        const v = /<(?:\w+:)?v[^>]*>([^<]*)<\/(?:\w+:)?v>/.exec(body);
        const idx = v ? parseInt(v[1], 10) : NaN;
        cells.push(Number.isFinite(idx) && strings[idx] !== undefined ? strings[idx] : '');
      } else if (/<(?:\w+:)?is\b/.test(body)) {
        const t = /<(?:\w+:)?t[^>]*>([^<]*)<\/(?:\w+:)?t>/.exec(body);
        cells.push(t ? t[1] : '');
      } else {
        const v = /<(?:\w+:)?v[^>]*>([^<]*)<\/(?:\w+:)?v>/.exec(body);
        cells.push(v ? v[1] : '');
      }
    }
    rows.push(cells.join('\t'));
  }
  const text = rows.join('\n');
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// Unzip one OOXML part to stdout text (used for document.xml / sheets).
export function buildUnzipPartPs(zipPath: string, partPath: string): string {
  return [
    `$z=${psQuote(zipPath)}; $t=[IO.Path]::Combine([IO.Path]::GetTempPath(),[IO.Path]::GetRandomFileName());`,
    `[IO.Compression.ZipFile]::ExtractToDirectory($z,$t);`,
    `Get-Content -Raw (Join-Path $t ${psQuote(partPath)});`,
    `Remove-Item -Recurse -Force $t`,
  ].join(' ');
}

// Full .docx read in one script (unzip + strip tags in PowerShell).
export function buildReadDocxPs(zipPath: string): string {
  return [
    `$z=${psQuote(zipPath)}; $t=[IO.Path]::Combine([IO.Path]::GetTempPath(),[IO.Path]::GetRandomFileName());`,
    `[IO.Compression.ZipFile]::ExtractToDirectory($z,$t);`,
    `$x=[xml](Get-Content -Raw (Join-Path $t 'word/document.xml'));`,
    `$ns=@{w='http://schemas.openxmlformats.org/wordprocessingml/2006/main'};`,
    `(Select-Xml -Xml $x -Namespace $ns -XPath '//w:p').Node | ForEach-Object { ($_.SelectNodes('.//w:t', $ns.Value) | ForEach-Object { $_.InnerText }) -join '' };`,
    `Remove-Item -Recurse -Force $t`,
  ].join(' ');
}

// .xlsx first-sheet read (shared strings + rows → TSV lines).
export function buildReadXlsxPs(zipPath: string, maxRows = 200): string {
  return [
    `$z=${psQuote(zipPath)}; $t=[IO.Path]::Combine([IO.Path]::GetTempPath(),[IO.Path]::GetRandomFileName());`,
    `[IO.Compression.ZipFile]::ExtractToDirectory($z,$t);`,
    `$ss=@(); $ssp=Join-Path $t 'xl/sharedStrings.xml';`,
    `if (Test-Path $ssp) { $sxml=[xml](Get-Content -Raw $ssp); $ss=@($sxml.sst.s | ForEach-Object { ($_.t | ForEach-Object { $_.InnerText }) -join '' }); }`,
    `$sh=(Get-ChildItem (Join-Path $t 'xl/worksheets') -Filter 'sheet*.xml' | Sort-Object Name | Select-Object -First 1).FullName;`,
    `$wxml=[xml](Get-Content -Raw $sh); $n=0;`,
    `foreach ($row in $wxml.worksheet.sheetData.row) { if ($n -ge ${maxRows}) { break }; $n++;`,
    ` ($row.c | ForEach-Object { if ($_.t -eq 's') { $ss[[int]$_.v] } else { $_.v } }) -join "\`t" };`,
    `Remove-Item -Recurse -Force $t`,
  ].join(' ');
}

// Edit a .docx paragraph via COM Word (Office must be installed).
export function buildEditDocxComPs(docPath: string, oldText: string, newText: string): string {
  return [
    `$w=New-Object -ComObject Word.Application; $w.Visible=$false;`,
    `$d=$w.Documents.Open(${psQuote(docPath)}); $n=0;`,
    `foreach ($p in $d.Paragraphs) { if ($p.Range.Text -like ${psQuote(`*${oldText}*`)}) { $p.Range.Text=$p.Range.Text.Replace(${psQuote(oldText)}, ${psQuote(newText)}); $n++ } };`,
    `$d.Save(); $d.Close(); $w.Quit(); "replaced:$n"`,
  ].join(' ');
}

// Edit .xlsx cells via COM Excel (Office must be installed).
export function buildEditXlsxComPs(docPath: string, oldText: string, newText: string): string {
  return [
    `$x=New-Object -ComObject Excel.Application; $x.Visible=$false; $x.DisplayAlerts=$false;`,
    `$b=$x.Workbooks.Open(${psQuote(docPath)}); $n=0;`,
    `foreach ($s in $b.Worksheets) { $f=$s.Cells.Find(${psQuote(oldText)}); while ($f) { $f.Value2=$f.Value2.ToString().Replace(${psQuote(oldText)}, ${psQuote(newText)}); $n++; $f=$s.Cells.FindNext($f) } };`,
    `$b.Save(); $b.Close(); $x.Quit(); "replaced:$n"`,
  ].join(' ');
}

// PDF text via pdftotext (poppler) when present — else the caller falls back
// to free web endpoints. Pure detection, no install attempts.
export function buildPdfToolProbe(): string {
  return `if (Get-Command pdftotext -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`;
}

export function buildReadPdfPs(pdfPath: string, maxPages = 0): string {
  const pages = maxPages > 0 ? ` -f 1 -l ${maxPages}` : '';
  return `pdftotext -layout${pages} ${psQuote(pdfPath)} -`;
}

// ZIP via built-in Compress-Archive (PS5.1+, always present on Windows).
export function buildZipCompressPs(sourcePath: string, outPath: string): string {
  return `Compress-Archive -Path ${psQuote(sourcePath)} -DestinationPath ${psQuote(outPath)} -Force`;
}

export function buildZipListPs(zipPath: string): string {
  return [
    `$z=[IO.Compression.ZipFile]::OpenRead(${psQuote(zipPath)});`,
    `$z.Entries | ForEach-Object { $_.FullName }; $z.Dispose()`,
  ].join(' ');
}

// ffmpeg probe for audio/video work (bundled with STT sidecar or system).
export function buildFfmpegProbe(): string {
  return `if (Get-Command ffmpeg -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`;
}
