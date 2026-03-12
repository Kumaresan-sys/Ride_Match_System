'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class SupportTicketStorageService {
  constructor(config) {
    this.backend = config.storage.backend || 'local';
    this.localPath = path.resolve(config.support?.uploadDir || './uploads/support-tickets');
  }

  _safeSegment(value, fallback = 'unknown') {
    const safe = String(value || fallback).replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!safe || safe === '.' || safe === '..') {
      throw Object.assign(new Error('Invalid support storage segment'), { statusCode: 400 });
    }
    return safe;
  }

  _safeFilename(filename) {
    const normalized = path.basename(String(filename || 'attachment'));
    const safe = normalized.replace(/[^a-zA-Z0-9._-]/g, '_');
    return safe || 'attachment';
  }

  _absolutePathForStorageKey(storageKey) {
    const absolute = path.resolve(this.localPath, storageKey);
    const root = path.resolve(this.localPath);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
      throw Object.assign(new Error('Invalid support attachment storage key'), { statusCode: 400 });
    }
    return absolute;
  }

  async _ensureDir(ticketId) {
    const dir = path.join(this.localPath, this._safeSegment(ticketId));
    const resolved = path.resolve(dir);
    const root = path.resolve(this.localPath);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw Object.assign(new Error('Invalid support attachment path'), { statusCode: 400 });
    }
    await fs.promises.mkdir(dir, { recursive: true });
    return dir;
  }

  _relativeStorageKey(ticketId, filename) {
    return path.posix.join(this._safeSegment(ticketId), filename);
  }

  _uniqueFilename(originalFilename) {
    const safeName = this._safeFilename(originalFilename);
    const ext = path.extname(safeName);
    const base = path.basename(safeName, ext).slice(0, 80) || 'attachment';
    return `${base}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  }

  async save(ticketId, originalFilename, buffer) {
    if (this.backend !== 'local') {
      throw new Error(`Storage backend '${this.backend}' not implemented`);
    }
    const dir = await this._ensureDir(ticketId);
    const safeName = this._uniqueFilename(originalFilename);
    const storageKey = this._relativeStorageKey(ticketId, safeName);
    const absolutePath = path.join(dir, safeName);
    await fs.promises.writeFile(absolutePath, buffer);
    return {
      storageBackend: 'local',
      storageKey,
      safeName,
      originalName: this._safeFilename(originalFilename),
      sizeBytes: buffer.length,
      checksumSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    };
  }

  async read(storageKey) {
    return fs.promises.readFile(this._absolutePathForStorageKey(storageKey));
  }

  async delete(storageKey) {
    try {
      await fs.promises.unlink(this._absolutePathForStorageKey(storageKey));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  buildDownloadUrl(ticketId, attachmentId) {
    return `/api/v1/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}`;
  }
}

module.exports = SupportTicketStorageService;
