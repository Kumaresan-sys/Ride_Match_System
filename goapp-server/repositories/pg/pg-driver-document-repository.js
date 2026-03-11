'use strict';

const domainDb = require('../../infra/db/domain-db');

class PgDriverDocumentRepository {
  async listByDriver(driverId, { includeInactive = false, documentType = null } = {}) {
    const values = [driverId];
    const where = ['driver_id::text = $1'];

    if (!includeInactive) {
      where.push('is_active = true');
    }
    if (documentType) {
      values.push(documentType);
      where.push(`document_type = $${values.length}`);
    }

    const { rows } = await domainDb.query(
      'drivers',
      `SELECT
         id,
         driver_id AS "driverId",
         document_type AS "documentType",
         document_url AS "documentUrl",
         storage_backend AS "storageBackend",
         storage_key AS "storageKey",
         stored_path AS "storedPath",
         mime_type AS "mimeType",
         file_size_bytes AS "fileSizeBytes",
         checksum_sha256 AS "checksumSha256",
         original_filename AS "originalFilename",
         is_active AS "isActive",
         document_number AS "documentNumber",
         expiry_date AS "expiryDate",
         verification_status AS "verificationStatus",
         rejection_reason AS "rejectionReason",
         verified_by AS "verifiedBy",
         verified_at AS "verifiedAt",
         uploaded_at AS "uploadedAt",
         updated_at AS "updatedAt"
       FROM driver_documents
       WHERE ${where.join(' AND ')}
       ORDER BY uploaded_at DESC, updated_at DESC`,
      values,
      { role: 'reader', strongRead: true }
    );

    return rows;
  }

  async getById(driverId, documentId, { includeInactive = true } = {}) {
    const values = [driverId, documentId];
    const where = ['driver_id::text = $1', 'id::text = $2'];
    if (!includeInactive) where.push('is_active = true');

    const { rows } = await domainDb.query(
      'drivers',
      `SELECT
         id,
         driver_id AS "driverId",
         document_type AS "documentType",
         document_url AS "documentUrl",
         storage_backend AS "storageBackend",
         storage_key AS "storageKey",
         stored_path AS "storedPath",
         mime_type AS "mimeType",
         file_size_bytes AS "fileSizeBytes",
         checksum_sha256 AS "checksumSha256",
         original_filename AS "originalFilename",
         is_active AS "isActive",
         document_number AS "documentNumber",
         expiry_date AS "expiryDate",
         verification_status AS "verificationStatus",
         rejection_reason AS "rejectionReason",
         verified_by AS "verifiedBy",
         verified_at AS "verifiedAt",
         uploaded_at AS "uploadedAt",
         updated_at AS "updatedAt"
       FROM driver_documents
       WHERE ${where.join(' AND ')}
       LIMIT 1`,
      values,
      { role: 'reader', strongRead: true }
    );

    return rows[0] || null;
  }

  async getLatestProfilePhoto(driverId, { verifiedOnly = true } = {}) {
    const values = [driverId];
    const where = [
      'driver_id::text = $1',
      "document_type = 'profile_photo'",
      'is_active = true',
    ];
    if (verifiedOnly) {
      where.push("verification_status = 'verified'");
    }

    const { rows } = await domainDb.query(
      'drivers',
      `SELECT
         id,
         driver_id AS "driverId",
         document_type AS "documentType",
         document_url AS "documentUrl",
         storage_backend AS "storageBackend",
         storage_key AS "storageKey",
         stored_path AS "storedPath",
         mime_type AS "mimeType",
         file_size_bytes AS "fileSizeBytes",
         checksum_sha256 AS "checksumSha256",
         original_filename AS "originalFilename",
         is_active AS "isActive",
         document_number AS "documentNumber",
         expiry_date AS "expiryDate",
         verification_status AS "verificationStatus",
         rejection_reason AS "rejectionReason",
         verified_by AS "verifiedBy",
         verified_at AS "verifiedAt",
         uploaded_at AS "uploadedAt",
         updated_at AS "updatedAt",
         EXTRACT(EPOCH FROM COALESCE(updated_at, uploaded_at))::bigint AS "avatarVersion"
       FROM driver_documents
       WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(updated_at, uploaded_at) DESC, uploaded_at DESC
       LIMIT 1`,
      values,
      { role: 'reader', strongRead: true }
    );

    return rows[0] || null;
  }

  async createDocument(record, client = null) {
    const queryable = client || {
      query: (text, params) => domainDb.query('drivers', text, params, { role: 'writer', strongRead: true }),
    };
    const { rows } = await queryable.query(
      `INSERT INTO driver_documents (
         id,
         driver_id,
         document_type,
         document_url,
         storage_backend,
         storage_key,
         stored_path,
         mime_type,
         file_size_bytes,
         checksum_sha256,
         original_filename,
         is_active,
         document_number,
         expiry_date,
         verification_status,
         rejection_reason,
         verified_by,
         verified_at,
         uploaded_at,
         updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, true),
         $13, $14, COALESCE($15, 'pending'), $16, $17, $18, COALESCE($19, NOW()), NOW()
       )
       RETURNING
         id,
         driver_id AS "driverId",
         document_type AS "documentType",
         document_url AS "documentUrl",
         storage_backend AS "storageBackend",
         storage_key AS "storageKey",
         stored_path AS "storedPath",
         mime_type AS "mimeType",
         file_size_bytes AS "fileSizeBytes",
         checksum_sha256 AS "checksumSha256",
         original_filename AS "originalFilename",
         is_active AS "isActive",
         document_number AS "documentNumber",
         expiry_date AS "expiryDate",
         verification_status AS "verificationStatus",
         rejection_reason AS "rejectionReason",
         verified_by AS "verifiedBy",
         verified_at AS "verifiedAt",
         uploaded_at AS "uploadedAt",
         updated_at AS "updatedAt"`,
      [
        record.id,
        record.driverId,
        record.documentType,
        record.documentUrl,
        record.storageBackend || 'local',
        record.storageKey || null,
        record.storedPath || null,
        record.mimeType || null,
        record.fileSizeBytes || null,
        record.checksumSha256 || null,
        record.originalFilename || null,
        record.isActive,
        record.documentNumber || null,
        record.expiryDate || null,
        record.verificationStatus || 'pending',
        record.rejectionReason || null,
        record.verifiedBy || null,
        record.verifiedAt || null,
        record.uploadedAt || null,
      ]
    );
    return rows[0] || null;
  }

  async deactivateActiveDocuments(driverId, documentType, client = null) {
    const queryable = client || {
      query: (text, params) => domainDb.query('drivers', text, params, { role: 'writer', strongRead: true }),
    };
    await queryable.query(
      `UPDATE driver_documents
       SET is_active = false,
           updated_at = NOW()
       WHERE driver_id = $1
         AND document_type = $2
         AND is_active = true`,
      [driverId, documentType]
    );
  }

  async updateVerification(documentId, { status, rejectionReason = null, verifiedBy = null, verifiedAt = new Date() }, client = null) {
    const queryable = client || {
      query: (text, params) => domainDb.query('drivers', text, params, { role: 'writer', strongRead: true }),
    };
    const { rows } = await queryable.query(
      `UPDATE driver_documents
       SET verification_status = $2,
           rejection_reason = CASE WHEN $2 = 'rejected' THEN $3 ELSE NULL END,
           verified_by = $4,
           verified_at = $5,
           updated_at = NOW()
       WHERE id::text = $1
       RETURNING
         id,
         driver_id AS "driverId",
         document_type AS "documentType",
         document_url AS "documentUrl",
         storage_backend AS "storageBackend",
         storage_key AS "storageKey",
         stored_path AS "storedPath",
         mime_type AS "mimeType",
         file_size_bytes AS "fileSizeBytes",
         checksum_sha256 AS "checksumSha256",
         original_filename AS "originalFilename",
         is_active AS "isActive",
         document_number AS "documentNumber",
         expiry_date AS "expiryDate",
         verification_status AS "verificationStatus",
         rejection_reason AS "rejectionReason",
         verified_by AS "verifiedBy",
         verified_at AS "verifiedAt",
         uploaded_at AS "uploadedAt",
         updated_at AS "updatedAt"`,
      [documentId, status, rejectionReason, verifiedBy, verifiedAt]
    );
    return rows[0] || null;
  }

  async deactivateDocument(driverId, documentId, client = null) {
    const queryable = client || {
      query: (text, params) => domainDb.query('drivers', text, params, { role: 'writer', strongRead: true }),
    };
    const { rows } = await queryable.query(
      `UPDATE driver_documents
       SET is_active = false,
           updated_at = NOW()
       WHERE id::text = $1
         AND driver_id::text = $2
       RETURNING
         id,
         driver_id AS "driverId",
         document_type AS "documentType",
         document_url AS "documentUrl",
         storage_backend AS "storageBackend",
         storage_key AS "storageKey",
         stored_path AS "storedPath",
         mime_type AS "mimeType",
         file_size_bytes AS "fileSizeBytes",
         checksum_sha256 AS "checksumSha256",
         original_filename AS "originalFilename",
         is_active AS "isActive",
         document_number AS "documentNumber",
         expiry_date AS "expiryDate",
         verification_status AS "verificationStatus",
         rejection_reason AS "rejectionReason",
         verified_by AS "verifiedBy",
         verified_at AS "verifiedAt",
         uploaded_at AS "uploadedAt",
         updated_at AS "updatedAt"`,
      [documentId, driverId]
    );
    return rows[0] || null;
  }

  async resolveDriverByLookup(lookup) {
    if (!lookup) return null;
    const { rows } = await domainDb.query(
      'drivers',
      `SELECT id AS "driverId", user_id AS "userId"
       FROM drivers
       WHERE id::text = $1 OR user_id::text = $1
       LIMIT 1`,
      [lookup],
      { role: 'reader', strongRead: true }
    );
    return rows[0] || null;
  }
}

module.exports = new PgDriverDocumentRepository();
