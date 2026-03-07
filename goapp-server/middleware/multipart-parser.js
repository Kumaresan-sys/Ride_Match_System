// Lightweight multipart/form-data parser using Node.js Buffers.
// Handles file uploads and text fields without external dependencies.

async function parseMultipart(req, maxBytes) {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) {
    throw Object.assign(new Error('Missing multipart boundary'), { statusCode: 400 });
  }
  const boundary = boundaryMatch[1].replace(/^"(.*)"$/, '$1');

  // Read full body as Buffer
  const rawBody = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(Object.assign(new Error('Upload too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  return parseMultipartBuffer(rawBody, boundary);
}

function parseMultipartBuffer(rawBody, boundary) {
  const fields = {};
  const files = [];

  const delimiter = Buffer.from(`--${boundary}`);
  const CRLF = Buffer.from('\r\n');
  const CRLFCRLF = Buffer.from('\r\n\r\n');

  // Split the raw body on the boundary delimiter
  const parts = splitBuffer(rawBody, delimiter);

  for (const part of parts) {
    // Skip preamble, epilogue, and the final '--' terminator
    if (part.length === 0) continue;
    const trimmed = stripCRLF(part);
    if (trimmed.equals(Buffer.from('--')) || trimmed.length === 0) continue;

    // Find the header/body split
    const headerEnd = indexOfBuffer(trimmed, CRLFCRLF);
    if (headerEnd === -1) continue;

    const headerBlock = trimmed.slice(0, headerEnd).toString('utf8');
    const bodyBuffer = trimmed.slice(headerEnd + CRLFCRLF.length);

    const headers = parsePartHeaders(headerBlock);
    const disposition = headers['content-disposition'] || '';
    const fieldName = extractParam(disposition, 'name');
    const filename = extractParam(disposition, 'filename');
    const mimeType = (headers['content-type'] || 'application/octet-stream').trim();

    if (!fieldName) continue;

    if (filename !== null) {
      // File field
      files.push({ fieldName, filename, mimeType, data: bodyBuffer });
    } else {
      // Text field
      fields[fieldName] = bodyBuffer.toString('utf8');
    }
  }

  return { fields, files };
}

// Split a Buffer on a delimiter Buffer, returning array of in-between segments
function splitBuffer(buf, delimiter) {
  const parts = [];
  let start = 0;
  let pos = indexOfBuffer(buf, delimiter, start);
  while (pos !== -1) {
    parts.push(buf.slice(start, pos));
    start = pos + delimiter.length;
    pos = indexOfBuffer(buf, delimiter, start);
  }
  parts.push(buf.slice(start));
  return parts;
}

// Find the first occurrence of needle in haystack starting at offset
function indexOfBuffer(haystack, needle, offset = 0) {
  if (needle.length === 0) return offset;
  outer: for (let i = offset; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// Strip leading/trailing CRLF from a Buffer
function stripCRLF(buf) {
  let start = 0;
  let end = buf.length;
  if (buf[0] === 0x0d && buf[1] === 0x0a) start = 2;
  if (buf[end - 2] === 0x0d && buf[end - 1] === 0x0a) end -= 2;
  return buf.slice(start, end);
}

// Parse part headers (Content-Disposition, Content-Type, etc.) into a plain object
function parsePartHeaders(headerBlock) {
  const headers = {};
  for (const line of headerBlock.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[key] = value;
  }
  return headers;
}

// Extract a named parameter from a Content-Disposition header value
// e.g. 'form-data; name="file"; filename="photo.jpg"' → extractParam(..., 'filename') === 'photo.jpg'
// Returns null if the param is absent (not the same as empty string)
function extractParam(header, param) {
  const re = new RegExp(`(?:^|;)\\s*${param}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, 'i');
  const match = header.match(re);
  if (!match) return null;
  return match[1] !== undefined ? match[1] : match[2];
}

module.exports = { parseMultipart };
