'use strict';

const crypto = require('crypto');

const domainDb = require('../infra/db/domain-db');
const documentRepository = require('../repositories/pg/pg-driver-document-repository');
const domainProjectionService = require('./domain-projection-service');
const { eventBus } = require('../utils/logger');

const VALID_DOCUMENT_TYPES = new Set([
  'license', 'rc_book', 'insurance', 'permit', 'aadhar', 'pan', 'profile_photo', 'vehicle_photo',
]);

const VALID_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/svg+xml', 'application/pdf',
]);

const VALID_VERIFICATION_STATUSES = new Set(['pending', 'verified', 'rejected', 'expired']);

class DriverDocumentService {
  constructor(storageService) {
    this.storage = storageService;
  }

  async uploadDocument(driverId, {
    documentType,
    documentNumber,
    expiryDate,
    filename,
    mimeType,
    buffer,
    verificationStatus = 'pending',
    verifiedBy = null,
    verifiedAt = null,
    isActive = true,
  }) {
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
        error: `Unsupported file type '${mimeType}'. Allowed: JPEG, PNG, WebP, SVG, PDF`,
        status: 415,
      };
    }
    if (!buffer || buffer.length === 0) {
      return { success: false, error: 'File data is empty', status: 400 };
    }

    const documentId = crypto.randomUUID();
    const now = new Date();
    let saved = null;

    try {
      saved = await this.storage.save(
        driverId,
        documentType,
        filename || `${documentType}.bin`,
        buffer,
      );

      const created = await domainDb.withTransaction('drivers', async (client) => {
        if (documentType === 'profile_photo' && isActive) {
          await documentRepository.deactivateActiveDocuments(driverId, documentType, client);
        }

        return documentRepository.createDocument({
          id: documentId,
          driverId,
          documentType,
          documentUrl: this.storage.buildDocumentUrl(driverId, documentId),
          storageBackend: saved.storageBackend,
          storageKey: saved.storageKey,
          storedPath: saved.storedPath,
          mimeType,
          fileSizeBytes: saved.fileSizeBytes,
          checksumSha256: saved.checksumSha256,
          originalFilename: filename || `${documentType}.bin`,
          isActive,
          documentNumber: documentNumber || null,
          expiryDate: expiryDate || null,
          verificationStatus,
          rejectionReason: null,
          verifiedBy,
          verifiedAt,
          uploadedAt: now,
        }, client);
      });

      await this._syncDriverProfileIfNeeded(documentType, driverId, {
        documentId,
        phase: 'uploaded',
        verificationStatus,
      });

      return { success: true, document: this._sanitize(created) };
    } catch (err) {
      if (saved?.storageKey || saved?.storedPath) {
        await this.storage.delete(saved.storageKey || null, saved.storedPath || null).catch(() => {});
      }
      return { success: false, error: `Failed to save file: ${err.message}`, status: 500 };
    }
  }

  async listDocuments(driverId) {
    const docs = await documentRepository.listByDriver(driverId, { includeInactive: false });
    return { success: true, documents: docs.map((doc) => this._sanitize(doc)) };
  }

  async getDocument(driverId, docId) {
    const doc = await documentRepository.getById(driverId, docId, { includeInactive: true });
    if (!doc) return { success: false, error: 'Document not found', status: 404 };
    return { success: true, document: this._sanitize(doc) };
  }

  async getDocumentFile(driverId, docId) {
    const doc = await documentRepository.getById(driverId, docId, { includeInactive: true });
    if (!doc || !doc.isActive) {
      return { success: false, error: 'Document not found', status: 404 };
    }
    try {
      const buffer = await this.storage.read(doc.storageKey || null, doc.storedPath || null);
      return {
        success: true,
        buffer,
        mimeType: doc.mimeType || 'application/octet-stream',
        filename: doc.originalFilename || `${doc.documentType}-${doc.id}`,
      };
    } catch (err) {
      return { success: false, error: 'File not found on storage', status: 404 };
    }
  }

  async getDriverAvatar(driverId) {
    const doc = await documentRepository.getLatestProfilePhoto(driverId, { verifiedOnly: true });
    if (!doc) {
      return { success: false, error: 'Avatar not found', status: 404 };
    }
    try {
      const buffer = await this.storage.read(doc.storageKey || null, doc.storedPath || null);
      return {
        success: true,
        buffer,
        mimeType: doc.mimeType || 'image/png',
        filename: doc.originalFilename || `${driverId}-avatar`,
        avatarVersion: doc.avatarVersion || null,
      };
    } catch (err) {
      return { success: false, error: 'Avatar file not found on storage', status: 404 };
    }
  }

  async verifyDocument(docId, status, rejectionReason, verifiedBy) {
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

    const existing = await this._getDocumentById(docId);
    if (!existing) return { success: false, error: 'Document not found', status: 404 };

    const updated = await documentRepository.updateVerification(docId, {
      status,
      rejectionReason: rejectionReason || null,
      verifiedBy: this._normalizeVerifiedBy(verifiedBy),
      verifiedAt: new Date(),
    });

    await this._syncDriverProfileIfNeeded(existing.documentType, existing.driverId, {
      documentId: existing.id,
      phase: 'verified',
      verificationStatus: status,
    });

    return { success: true, document: this._sanitize(updated) };
  }

  async deleteDocument(driverId, docId) {
    const doc = await documentRepository.getById(driverId, docId, { includeInactive: true });
    if (!doc) return { success: false, error: 'Document not found', status: 404 };

    await documentRepository.deactivateDocument(driverId, docId);
    await this.storage.delete(doc.storageKey || null, doc.storedPath || null).catch(() => {});
    await this._syncDriverProfileIfNeeded(doc.documentType, driverId, {
      documentId: doc.id,
      phase: 'deleted',
      verificationStatus: doc.verificationStatus,
    });
    return { success: true, message: 'Document deleted' };
  }

  async resolveDriverAccess(driverLookup) {
    return documentRepository.resolveDriverByLookup(driverLookup);
  }

  async _getDocumentById(docId) {
    const docs = await domainDb.query(
      'drivers',
      `SELECT
         id,
         driver_id AS "driverId",
         document_type AS "documentType",
         verification_status AS "verificationStatus",
         is_active AS "isActive"
       FROM driver_documents
       WHERE id::text = $1
       LIMIT 1`,
      [docId],
      { role: 'reader', strongRead: true }
    );
    return docs.rows[0] || null;
  }

  _normalizeVerifiedBy(verifiedBy) {
    const value = String(verifiedBy || '').trim();
    if (!value || value === 'admin') return null;
    return value;
  }

  async _syncDriverProfileIfNeeded(documentType, driverId, extra = {}) {
    if (documentType !== 'profile_photo') return;
    const payload = {
      driverId,
      ...extra,
      occurredAt: new Date().toISOString(),
    };
    eventBus.publish('driver_profile_updated', payload);
    await domainProjectionService.syncDriverByLookup(driverId).catch(() => null);
  }

  _sanitize(doc) {
    if (!doc) return null;
    return {
      id: doc.id,
      driverId: doc.driverId,
      documentType: doc.documentType,
      documentUrl: doc.documentUrl,
      fileUrl: doc.documentUrl,
      documentNumber: doc.documentNumber || null,
      expiryDate: doc.expiryDate || null,
      mimeType: doc.mimeType || null,
      originalFilename: doc.originalFilename || null,
      fileSizeBytes: doc.fileSizeBytes != null ? Number(doc.fileSizeBytes) : null,
      checksumSha256: doc.checksumSha256 || null,
      verificationStatus: doc.verificationStatus || 'pending',
      rejectionReason: doc.rejectionReason || null,
      verifiedBy: doc.verifiedBy || null,
      verifiedAt: doc.verifiedAt || null,
      uploadedAt: doc.uploadedAt || null,
      updatedAt: doc.updatedAt || doc.uploadedAt || null,
      isActive: doc.isActive !== false,
    };
  }
}

module.exports = DriverDocumentService;
