// Driver Document Storage Service
// Abstracts file storage: local filesystem (mock/dev) or S3 (production).
// Current implementation: local filesystem under UPLOAD_DIR.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class DocumentStorageService {
  constructor(config) {
    this.backend = config.storage.backend || 'local';
    this.localPath = path.resolve(config.storage.localPath || './uploads/driver-docs');
  }

  // Ensure the directory for a driver exists
  async _ensureDriverDir(driverId) {
    const dir = path.join(this.localPath, driverId);
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
   * Save a document file to storage.
   * @param {string} driverId
   * @param {string} documentType  e.g. 'license'
   * @param {string} originalFilename
   * @param {Buffer} buffer
   * @returns {{ url: string, storedPath: string }}
   */
  async saveDocument(driverId, documentType, originalFilename, buffer) {
    if (this.backend === 'local') {
      const dir = await this._ensureDriverDir(driverId);
      const filename = `${documentType}_${this._uniqueFilename(originalFilename)}`;
      const storedPath = path.join(dir, filename);
      await fs.promises.writeFile(storedPath, buffer);
      // URL is a relative path that the file-serve route will use
      const url = `/api/v1/drivers/${driverId}/documents`;  // placeholder; docId appended after record creation
      return { storedPath, filename };
    }
    throw new Error(`Storage backend '${this.backend}' not implemented`);
  }

  /**
   * Read a stored document as a Buffer.
   * @param {string} storedPath  Absolute path returned by saveDocument
   * @returns {Buffer}
   */
  async readDocument(storedPath) {
    return fs.promises.readFile(storedPath);
  }

  /**
   * Delete a stored document.
   * @param {string} storedPath
   */
  async deleteDocument(storedPath) {
    try {
      await fs.promises.unlink(storedPath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

module.exports = DocumentStorageService;
