'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PLAN_PATH = path.join(ROOT, 'migrations', 'domain-split', 'domain-extraction-plan.json');
const OUT_DIR = path.join(ROOT, 'docs');
const OUT_MD = path.join(OUT_DIR, 'database-schema.md');
const OUT_PDF = path.join(OUT_DIR, 'database-schema.pdf');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function formatDate(isoString) {
  const d = isoString ? new Date(isoString) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

function buildMarkdown(plan) {
  const totals = plan.totals || {};
  const byDomain = totals.byDomain || {};
  const domains = plan.domains || {};
  const generatedAt = formatDate(plan.generatedAt);

  const lines = [];
  lines.push('# GoApp Database Schema Document');
  lines.push('');
  lines.push(`Generated At: ${generatedAt}`);
  lines.push(`Source: ${plan.sourceDatabase || 'N/A'}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Total Tables: ${totals.tables || 0}`);
  lines.push(`- Unknown Tables: ${totals.unknown || 0}`);
  lines.push(`- Ignored Tables: ${totals.ignored || 0}`);
  lines.push('');
  lines.push('## Domain Split Overview');
  lines.push('');
  lines.push('| Domain | Table Count |');
  lines.push('|---|---:|');

  const orderedDomains = ['identity', 'drivers', 'rides', 'payments', 'analytics'];
  for (const domain of orderedDomains) {
    lines.push(`| ${domain}_db | ${byDomain[domain] || 0} |`);
  }

  lines.push('');
  lines.push('## Domain Tables');
  lines.push('');

  for (const domain of orderedDomains) {
    const tableNames = Array.isArray(domains[domain]) ? domains[domain] : [];
    lines.push(`### ${domain}_db (${tableNames.length} tables)`);
    lines.push('');
    for (const t of tableNames) {
      lines.push(`- ${t}`);
    }
    lines.push('');
  }

  lines.push('## Notes');
  lines.push('');
  lines.push('- This document is generated from domain extraction metadata.');
  lines.push('- Ownership mapping source: migrations/domain-split/domain-table-groups.js.');
  lines.push('- System extension table `spatial_ref_sys` is intentionally ignored.');
  lines.push('');

  return lines.join('\n');
}

function markdownToPlainText(markdown) {
  return markdown
    .replace(/^#\s+/gm, '')
    .replace(/^##\s+/gm, '')
    .replace(/^###\s+/gm, '')
    .replace(/^\|/gm, '')
    .replace(/\|\s*$/gm, '')
    .replace(/\|/g, '   ')
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/\* /g, '- ');
}

function wrapLine(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const words = text.split(' ');
  const out = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) out.push(current);
      if (word.length > maxChars) {
        let start = 0;
        while (start < word.length) {
          out.push(word.slice(start, start + maxChars));
          start += maxChars;
        }
        current = '';
      } else {
        current = word;
      }
    }
  }
  if (current) out.push(current);
  return out;
}

function escapePdfString(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildPdfFromText(text) {
  const linesRaw = text.split(/\r?\n/);
  const wrapped = [];
  const maxChars = 96;

  for (const line of linesRaw) {
    if (!line.trim()) {
      wrapped.push('');
      continue;
    }
    wrapped.push(...wrapLine(line, maxChars));
  }

  const linesPerPage = 52;
  const pages = [];
  for (let i = 0; i < wrapped.length; i += linesPerPage) {
    pages.push(wrapped.slice(i, i + linesPerPage));
  }

  let objId = 1;
  const catalogId = objId++;
  const pagesId = objId++;
  const fontId = objId++;

  const pageIds = [];
  const contentIds = [];

  for (let i = 0; i < pages.length; i++) {
    pageIds.push(objId++);
    contentIds.push(objId++);
  }

  const objects = [];
  const offsets = [0];

  function addObject(id, body) {
    objects.push({ id, body });
  }

  addObject(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  addObject(pagesId, `<< /Type /Pages /Count ${pages.length} /Kids [ ${pageIds.map((id) => `${id} 0 R`).join(' ')} ] >>`);
  addObject(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  for (let i = 0; i < pages.length; i++) {
    const pageId = pageIds[i];
    const contentId = contentIds[i];
    addObject(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);

    let stream = 'BT\n/F1 10 Tf\n1 0 0 1 45 760 Tm\n12 TL\n';
    for (const line of pages[i]) {
      stream += `(${escapePdfString(line)}) Tj\nT*\n`;
    }
    stream += 'ET\n';

    const contentBody = `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}endstream`;
    addObject(contentId, contentBody);
  }

  objects.sort((a, b) => a.id - b.id);

  let pdf = '%PDF-1.4\n';
  for (const obj of objects) {
    offsets[obj.id] = Buffer.byteLength(pdf, 'utf8');
    pdf += `${obj.id} 0 obj\n${obj.body}\nendobj\n`;
  }

  const xrefStart = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    const off = String(offsets[i] || 0).padStart(10, '0');
    pdf += `${off} 00000 n \n`;
  }

  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

function main() {
  const plan = readJson(PLAN_PATH);
  ensureDir(OUT_DIR);

  const md = buildMarkdown(plan);
  fs.writeFileSync(OUT_MD, md, 'utf8');

  const text = markdownToPlainText(md);
  const pdfBuffer = buildPdfFromText(text);
  fs.writeFileSync(OUT_PDF, pdfBuffer);

  console.log(JSON.stringify({
    ok: true,
    markdown: OUT_MD,
    pdf: OUT_PDF,
    tables: plan?.totals?.tables || 0,
    generatedAt: plan?.generatedAt || null,
  }, null, 2));
}

main();
