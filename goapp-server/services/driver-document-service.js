// Driver Document Service
// Manages driver KYC documents: upload, list, retrieve, verify/reject, delete.
// Uses in-memory Map for mock mode (same pattern as feedback-service, ticket-service).

const crypto = require('crypto');

const VALID_DOCUMENT_TYPES = new Set([
  'license', 'rc_book', 'insurance', 'permit', 'aadhar', 'pan', 'profile_photo', 'vehicle_photo',
]);

const VALID_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
]);

const VALID_VERIFICATION_STATUSES = new Set(['pending', 'verified', 'rejected', 'expired']);

class DriverDocumentService {
  constructor(storageService) {
    this.storage = storageService;
    // In-memory store: documentId → document record
    this.documents = new Map();
  }

  /**
   * Upload and register a driver document.
   * @param {string} driverId
   * @param {{ documentType, documentNumber, expiryDate, filename, mimeType, buffer }} opts
   * @returns {{ success: boolean, document?: object, error?: string }}
   */
  async uploadDocument(driverId, { documentType, documentNumber, expiryDate, filename, mimeType, buffer }) {
    if (!driverId) return { success: false, error: 'driverId is required', status: 400 };
    if (!VALID_DOCUMENT_TYPES.has(documentType)) {
      return {
        success: false,
        error: `Invalid document_type. Must be one of: ${[...VALID_DOCUMENT_TYPES].join(', ')}`,
        status: 400,
      };
    }
    if (!VALID_MIME_TYPES.has(mimeType)) {
      return {
        success: false,
        error: `Unsupported file type '${mimeType}'. Allowed: JPEG, PNG, WebP, PDF`,
        status: 415,
      };
    }
    if (!buffer || buffer.length === 0) {
      return { success: false, error: 'File data is empty', status: 400 };
    }

    let storedPath;
    try {
      const saved = await this.storage.saveDocument(driverId, documentType, filename || 'document', buffer);
      storedPath = saved.storedPath;
    } catch (err) {
      return { success: false, error: 'Failed to save file: ' + err.message, status: 500 };
    }

    const docId = crypto.randomUUID();
    const now = new Date().toISOString();
    const record = {
      id: docId,
      driverId,
      documentType,
      documentNumber: documentNumber || null,
      expiryDate: expiryDate || null,
      mimeType,
      originalFilename: filename || 'document',
      storedPath,
      verificationStatus: 'pending',
      rejectionReason: null,
      verifiedBy: null,
      verifiedAt: null,
      uploadedAt: now,
    };

    this.documents.set(docId, record);
    return { success: true, document: this._sanitize(record) };
  }

  /**
   * List all documents for a driver.
   * @param {string} driverId
   * @returns {{ success: boolean, documents: object[] }}
   */
  listDocuments(driverId) {
    const docs = [];
    for (const doc of this.documents.values()) {
      if (doc.driverId === driverId) docs.push(this._sanitize(doc));
    }
    docs.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
    return { success: true, documents: docs };
  }

  /**
   * Get a single document record.
   * @param {string} driverId
   * @param {string} docId
   */
  getDocument(driverId, docId) {
    const doc = this.documents.get(docId);
    if (!doc) return { success: false, error: 'Document not found', status: 404 };
    if (doc.driverId !== driverId) return { success: false, error: 'Document not found', status: 404 };
    return { success: true, document: this._sanitize(doc) };
  }

  /**
   * Read the raw file buffer for serving.
   * @param {string} driverId
   * @param {string} docId
   * @returns {{ success: boolean, buffer?: Buffer, mimeType?: string, filename?: string, error?: string }}
   */
  async getDocumentFile(driverId, docId) {
    const doc = this.documents.get(docId);
    if (!doc) return { success: false, error: 'Document not found', status: 404 };
    if (doc.driverId !== driverId) return { success: false, error: 'Document not found', status: 404 };
    try {
      const buffer = await this.storage.readDocument(doc.storedPath);
      return { success: true, buffer, mimeType: doc.mimeType, filename: doc.originalFilename };
    } catch (err) {
      return { success: false, error: 'File not found on storage', status: 404 };
    }
  }

  /**
   * Admin: verify or reject a document.
   * @param {string} docId
   * @param {string} status  'verified' | 'rejected' | 'expired'
   * @param {string|null} rejectionReason
   * @param {string} verifiedBy  admin user ID or identifier
   */
  verifyDocument(docId, status, rejectionReason, verifiedBy) {
    if (!VALID_VERIFICATION_STATUSES.has(status)) {
      return {
        success: false,
        error: `Invalid status. Must be one of: ${[...VALID_VERIFICATION_STATUSES].join(', ')}`,
        status: 400,
      };
    }
    if (status === 'rejected' && !rejectionReason) {
      return { success: false, error: 'rejection_reason is required when rejecting a document', status: 400 };
    }

    const doc = this.documents.get(docId);
    if (!doc) return { success: false, error: 'Document not found', status: 404 };

    doc.verificationStatus = status;
    doc.rejectionReason = status === 'rejected' ? rejectionReason : null;
    doc.verifiedBy = verifiedBy || null;
    doc.verifiedAt = new Date().toISOString();
    return { success: true, document: this._sanitize(doc) };
  }

  /**
   * Delete a document and its stored file.
   * @param {string} driverId
   * @param {string} docId
   */
  async deleteDocument(driverId, docId) {
    const doc = this.documents.get(docId);
    if (!doc) return { success: false, error: 'Document not found', status: 404 };
    if (doc.driverId !== driverId) return { success: false, error: 'Document not found', status: 404 };

    try {
      await this.storage.deleteDocument(doc.storedPath);
    } catch (err) {
      // Log but don't block deletion of the record
    }
    this.documents.delete(docId);
    return { success: true, message: 'Document deleted' };
  }

  // Remove internal fields before returning to client
  _sanitize(doc) {
    const { storedPath, ...rest } = doc;
    return rest;
  }
}

module.exports = DriverDocumentService;
