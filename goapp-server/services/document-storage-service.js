// Driver media storage service.
// Local filesystem now; adapter boundary kept for future S3 migration.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class DocumentStorageService {
  constructor(config) {
    this.backend = config.storage.backend || 'local';
    this.localPath = path.resolve(config.storage.localPath || './uploads/driver-media');
  }

  // Sanitize driverId to prevent path traversal (e.g. ../../../etc)
  _safeDriverSegment(driverId) {
    // Allow only alphanumeric, hyphens, underscores — matches UUID and D001-style IDs
    const safe = driverId.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!safe || safe === '.' || safe === '..') throw Object.assign(new Error('Invalid driverId'), { statusCode: 400 });
    return safe;
  }

  _relativeStorageKey(driverId, documentType, filename) {
    return path.posix.join('drivers', this._safeDriverSegment(driverId), documentType, filename);
  }

  _absolutePathForStorageKey(storageKey) {
    const absolute = path.resolve(this.localPath, storageKey);
    const localRoot = path.resolve(this.localPath);
    if (absolute !== localRoot && !absolute.startsWith(`${localRoot}${path.sep}`)) {
      throw Object.assign(new Error('Invalid storage key'), { statusCode: 400 });
    }
    return absolute;
  }

  async _ensureDriverDir(driverId, documentType) {
    const segment = this._safeDriverSegment(driverId);
    const safeType = String(documentType || 'misc').replace(/[^a-zA-Z0-9_-]/g, '_') || 'misc';
    const dir = path.join(this.localPath, 'drivers', segment, safeType);
    const resolved = path.resolve(dir);
    const localRoot = path.resolve(this.localPath);
    if (resolved !== localRoot && !resolved.startsWith(`${localRoot}${path.sep}`)) {
      throw Object.assign(new Error('Invalid driverId'), { statusCode: 400 });
    }
    await fs.promises.mkdir(dir, { recursive: true });
    return dir;
  }

  // Generate a unique filename to avoid collisions
  _uniqueFilename(originalFilename) {
    const ext = path.extname(originalFilename) || '';
    const id = crypto.randomBytes(12).toString('hex');
    return `${id}${ext}`;
  }

  /**
   * Save driver media.
   */
  async save(driverId, documentType, originalFilename, buffer) {
    if (this.backend === 'local') {
      const dir = await this._ensureDriverDir(driverId, documentType);
      const filename = this._uniqueFilename(originalFilename || 'file');
      const storageKey = this._relativeStorageKey(driverId, documentType, filename);
      const storedPath = path.join(dir, filename);
      await fs.promises.writeFile(storedPath, buffer);
      const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
      return {
        storageKey,
        storedPath,
        filename,
        checksumSha256: checksum,
        fileSizeBytes: buffer.length,
        storageBackend: 'local',
      };
    }
    throw new Error(`Storage backend '${this.backend}' not implemented`);
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

  buildDocumentUrl(driverId, documentId) {
    return `/api/v1/drivers/${encodeURIComponent(driverId)}/documents/${encodeURIComponent(documentId)}/file`;
  }

  buildAvatarUrl(driverId, avatarVersion = null) {
    const base = `/api/v1/drivers/${encodeURIComponent(driverId)}/avatar`;
    if (avatarVersion == null) return base;
    return `${base}?v=${encodeURIComponent(String(avatarVersion))}`;
  }

  async saveDocument(driverId, documentType, originalFilename, buffer) {
    return this.save(driverId, documentType, originalFilename, buffer);
  }

  async readDocument(storageKeyOrPath, storedPath = null) {
    return this.read(storageKeyOrPath, storedPath);
  }

  async deleteDocument(storageKeyOrPath, storedPath = null) {
    return this.delete(storageKeyOrPath, storedPath);
  }
}

module.exports = DocumentStorageService;
