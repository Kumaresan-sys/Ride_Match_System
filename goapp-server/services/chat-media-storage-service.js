'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class ChatMediaStorageService {
  constructor(config) {
    this.backend = config.storage.backend || 'local';
    this.localPath = path.resolve(config.chat?.uploadDir || './uploads/chat-media');
  }

  _safeSegment(value, fallback = 'unknown') {
    const safe = String(value || fallback).replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!safe || safe === '.' || safe === '..') {
      throw Object.assign(new Error('Invalid storage segment'), { statusCode: 400 });
    }
    return safe;
  }

  _absolutePathForStorageKey(storageKey) {
    const absolute = path.resolve(this.localPath, storageKey);
    const root = path.resolve(this.localPath);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
      throw Object.assign(new Error('Invalid chat media storage key'), { statusCode: 400 });
    }
    return absolute;
  }

  _relativeStorageKey(conversationId, messageId, attachmentType, filename) {
    return path.posix.join(
      this._safeSegment(conversationId),
      this._safeSegment(messageId),
      this._safeSegment(attachmentType, 'file'),
      filename,
    );
  }

  async _ensureDir(conversationId, messageId, attachmentType) {
    const dir = path.join(
      this.localPath,
      this._safeSegment(conversationId),
      this._safeSegment(messageId),
      this._safeSegment(attachmentType, 'file'),
    );
    const resolved = path.resolve(dir);
    const root = path.resolve(this.localPath);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw Object.assign(new Error('Invalid chat media path'), { statusCode: 400 });
    }
    await fs.promises.mkdir(dir, { recursive: true });
    return dir;
  }

  _uniqueFilename(originalFilename) {
    const ext = path.extname(String(originalFilename || 'file')) || '';
    return `${crypto.randomBytes(12).toString('hex')}${ext}`;
  }

  async save(conversationId, messageId, attachmentType, originalFilename, buffer) {
    if (this.backend !== 'local') {
      throw new Error(`Storage backend '${this.backend}' not implemented`);
    }
    const dir = await this._ensureDir(conversationId, messageId, attachmentType);
    const filename = this._uniqueFilename(originalFilename || 'file');
    const storageKey = this._relativeStorageKey(conversationId, messageId, attachmentType, filename);
    const storedPath = path.join(dir, filename);
    await fs.promises.writeFile(storedPath, buffer);
    const checksumSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    return {
      storageBackend: 'local',
      storageKey,
      storedPath,
      filename,
      fileSizeBytes: buffer.length,
      checksumSha256,
    };
  }

  async read(storageKey, storedPath = null) {
    const target = storageKey
      ? this._absolutePathForStorageKey(storageKey)
      : path.resolve(storedPath || '');
    return fs.promises.readFile(target);
  }

  async delete(storageKey, storedPath = null) {
    const target = storageKey
      ? this._absolutePathForStorageKey(storageKey)
      : path.resolve(storedPath || '');
    try {
      await fs.promises.unlink(target);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  buildPublicUrl(rideId, attachmentId) {
    return `/api/v1/rides/${encodeURIComponent(rideId)}/chat/attachments/${encodeURIComponent(attachmentId)}`;
  }
}

module.exports = ChatMediaStorageService;
