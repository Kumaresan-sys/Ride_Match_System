'use strict';

const domainDb = require('../../infra/db/domain-db');

class PgSafetyRepository {
  constructor() {
    this._hasEmergencyDeletedAt = null;
    this._hasEmergencyRelationship = null;
    this._hasShareTrackingColumns = null;
  }

  // ── Emergency Contacts ────────────────────────────────────────────────────

  /**
   * Returns all emergency contacts for a user, primary first then by name.
   */
  async getContacts(userId) {
    const activeWhere = await this._activeContactWhere();
    const relationshipSelect = (await this._hasRelationshipColumn())
      ? 'relationship'
      : "NULL::varchar AS relationship";
    const { rows } = await domainDb.query('identity', 
      `SELECT id::text, contact_name, phone_number, ${relationshipSelect}, is_primary
       FROM emergency_contacts
       WHERE user_id = $1 AND ${activeWhere}
       ORDER BY is_primary DESC, contact_name ASC`,
      [userId]
    );
    return rows.map(this._mapContact);
  }

  /**
   * Adds a new emergency contact. At most 10 contacts per user.
   * If this is the first contact it becomes primary automatically.
   */
  async addContact(userId, { name, phoneNumber, relationship }) {
    const client = await domainDb.getClient('identity');
    try {
      await client.query('BEGIN');
      const activeWhere = await this._activeContactWhere();
      const hasRelationship = await this._hasRelationshipColumn();

      // Enforce max 10 contacts
      const { rows: countRows } = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM emergency_contacts
         WHERE user_id = $1 AND ${activeWhere}`,
        [userId]
      );
      if (countRows[0].cnt >= 10) {
        const err = new Error('You can add at most 10 emergency contacts.');
        err.code = 'CONTACTS_LIMIT';
        throw err;
      }

      // First contact becomes primary
      const isPrimary = countRows[0].cnt === 0;

      const query = hasRelationship
        ? `INSERT INTO emergency_contacts (user_id, contact_name, phone_number, relationship, is_primary)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id::text, contact_name, phone_number, relationship, is_primary`
        : `INSERT INTO emergency_contacts (user_id, contact_name, phone_number, is_primary)
           VALUES ($1, $2, $3, $4)
           RETURNING id::text, contact_name, phone_number, NULL::varchar AS relationship, is_primary`;
      const values = hasRelationship
        ? [userId, name, phoneNumber, relationship || null, isPrimary]
        : [userId, name, phoneNumber, isPrimary];
      const { rows } = await client.query(query, values);

      await client.query('COMMIT');
      return this._mapContact(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Soft-deletes a contact. If deleted contact was primary,
   * promotes the oldest remaining contact.
   */
  async deleteContact(userId, contactId) {
    const client = await domainDb.getClient('identity');
    try {
      await client.query('BEGIN');
      const activeWhere = await this._activeContactWhere();

      // Verify ownership
      const { rows: ownerRows } = await client.query(
        `SELECT id, is_primary FROM emergency_contacts
         WHERE id = $1 AND user_id = $2 AND ${activeWhere}`,
        [contactId, userId]
      );
      if (ownerRows.length === 0) {
        const err = new Error('Contact not found.');
        err.code = 'NOT_FOUND';
        throw err;
      }

      const wasPrimary = ownerRows[0].is_primary;

      if (await this._hasDeletedAtColumn()) {
        await client.query(
          `UPDATE emergency_contacts SET deleted_at = NOW() WHERE id = $1`,
          [contactId]
        );
      } else {
        await client.query(
          `DELETE FROM emergency_contacts WHERE id = $1`,
          [contactId]
        );
      }

      // Promote oldest remaining contact to primary if needed
      if (wasPrimary) {
        await client.query(
          `UPDATE emergency_contacts SET is_primary = true
           WHERE id = (
             SELECT id FROM emergency_contacts
             WHERE user_id = $1 AND ${activeWhere}
             ORDER BY created_at ASC LIMIT 1
           )`,
          [userId]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Sets one contact as primary and unsets all others for the user.
   */
  async makePrimary(userId, contactId) {
    const client = await domainDb.getClient('identity');
    try {
      await client.query('BEGIN');
      const activeWhere = await this._activeContactWhere();

      // Verify ownership
      const { rows } = await client.query(
        `SELECT id FROM emergency_contacts
         WHERE id = $1 AND user_id = $2 AND ${activeWhere}`,
        [contactId, userId]
      );
      if (rows.length === 0) {
        const err = new Error('Contact not found.');
        err.code = 'NOT_FOUND';
        throw err;
      }

      // Clear all primary flags for user
      await client.query(
        `UPDATE emergency_contacts SET is_primary = false
         WHERE user_id = $1 AND ${activeWhere}`,
        [userId]
      );

      // Set new primary
      await client.query(
        `UPDATE emergency_contacts SET is_primary = true WHERE id = $1`,
        [contactId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Updates name and/or phone number of an existing contact.
   */
  async updateContact(userId, contactId, { name, phoneNumber, relationship }) {
    const activeWhere = await this._activeContactWhere();
    const hasRelationship = await this._hasRelationshipColumn();
    const query = hasRelationship
      ? `UPDATE emergency_contacts
         SET contact_name = $3, phone_number = $4, relationship = $5
         WHERE id = $1 AND user_id = $2 AND ${activeWhere}
         RETURNING id::text, contact_name, phone_number, relationship, is_primary`
      : `UPDATE emergency_contacts
         SET contact_name = $3, phone_number = $4
         WHERE id = $1 AND user_id = $2 AND ${activeWhere}
         RETURNING id::text, contact_name, phone_number, NULL::varchar AS relationship, is_primary`;
    const { rows } = await domainDb.query('identity', 
      query,
      hasRelationship
        ? [contactId, userId, name, phoneNumber, relationship || null]
        : [contactId, userId, name, phoneNumber]
    );
    if (rows.length === 0) {
      const err = new Error('Contact not found.');
      err.code = 'NOT_FOUND';
      throw err;
    }
    return this._mapContact(rows[0]);
  }

  /**
   * Seeds the emergency_contacts table from the profile emergency_contact field.
   * Idempotent — skips if this phone number already exists for the user.
   */
  async seedProfileEmergencyContact(userId, phoneNumber) {
    if (!phoneNumber || !phoneNumber.trim()) return;
    const phone = phoneNumber.trim();

    const activeWhere = await this._activeContactWhere();
    // Skip if this number already exists (active contact)
    const { rows: existing } = await domainDb.query('identity', 
      `SELECT id FROM emergency_contacts
       WHERE user_id = $1 AND phone_number = $2 AND ${activeWhere}`,
      [userId, phone]
    );
    if (existing.length > 0) return;

    // Add as first contact (will auto-become primary if no others exist)
    await this.addContact(userId, {
      name: 'Emergency Contact',
      phoneNumber: phone,
      relationship: 'Emergency contact',
    });
  }

  // ── Safety Preferences ───────────────────────────────────────────────────

  /**
   * Returns safety preferences for a user (creates defaults if none exist).
   */
  async getPreferences(userId) {
    const { rows } = await domainDb.query('identity', 
      `INSERT INTO safety_preferences (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING auto_share, share_at_night`,
      [userId]
    );
    return { autoShare: rows[0].auto_share, shareAtNight: rows[0].share_at_night };
  }

  /**
   * Upserts safety preferences.
   */
  async updatePreferences(userId, { autoShare, shareAtNight }) {
    const { rows } = await domainDb.query('identity', 
      `INSERT INTO safety_preferences (user_id, auto_share, share_at_night)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
         SET auto_share     = EXCLUDED.auto_share,
             share_at_night = EXCLUDED.share_at_night,
             updated_at     = NOW()
       RETURNING auto_share, share_at_night`,
      [userId, autoShare, shareAtNight]
    );
    return { autoShare: rows[0].auto_share, shareAtNight: rows[0].share_at_night };
  }

  async getPrimaryContact(userId) {
    const activeWhere = await this._activeContactWhere();
    const relationshipSelect = (await this._hasRelationshipColumn())
      ? 'relationship'
      : "NULL::varchar AS relationship";
    const { rows } = await domainDb.query(
      'identity',
      `SELECT id::text,
              contact_name,
              phone_number,
              ${relationshipSelect},
              is_primary
       FROM emergency_contacts
       WHERE user_id = $1
         AND is_primary = true
         AND ${activeWhere}
       ORDER BY created_at ASC
       LIMIT 1`,
      [userId]
    );
    return rows[0] ? this._mapContact(rows[0]) : null;
  }

  async recordTrustedContactShare({
    rideDbId,
    userId,
    contactId,
    shareType = 'auto',
    shareUrl,
    expiresAt,
    trackingShareId = null,
  }) {
    const hasTrackingColumns = await this._hasTrustedShareTrackingColumns();
    const { rows } = await domainDb.query(
      'identity',
      hasTrackingColumns
        ? `INSERT INTO trusted_contacts_shares (
             ride_id,
             user_id,
             contact_id,
             share_type,
             share_url,
             expires_at,
             tracking_share_id,
             delivery_status,
             updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW())
           RETURNING id::text AS id`
        : `INSERT INTO trusted_contacts_shares (
             ride_id,
             user_id,
             contact_id,
             share_type,
             share_url,
             expires_at
           )
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id::text AS id`,
      hasTrackingColumns
        ? [rideDbId, userId, contactId, shareType, shareUrl, expiresAt, trackingShareId]
        : [rideDbId, userId, contactId, shareType, shareUrl, expiresAt]
    );
    return rows[0] || null;
  }

  async markTrustedContactShareDelivered(shareId, {
    providerName = null,
    providerMessageId = null,
  } = {}) {
    if (!shareId || !(await this._hasTrustedShareTrackingColumns())) return null;
    const { rows } = await domainDb.query(
      'identity',
      `UPDATE trusted_contacts_shares
       SET delivery_status = 'sent',
           provider_name = $2,
           provider_message_id = $3,
           failure_reason = NULL,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id::text AS id`,
      [shareId, providerName, providerMessageId]
    );
    return rows[0] || null;
  }

  async markTrustedContactShareFailed(shareId, {
    providerName = null,
    failureReason = null,
  } = {}) {
    if (!shareId || !(await this._hasTrustedShareTrackingColumns())) return null;
    const { rows } = await domainDb.query(
      'identity',
      `UPDATE trusted_contacts_shares
       SET delivery_status = 'failed',
           provider_name = $2,
           failure_reason = $3,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id::text AS id`,
      [shareId, providerName, failureReason]
    );
    return rows[0] || null;
  }

  async markTrustedContactShareViewedByTrackingShareId(trackingShareId) {
    if (!trackingShareId || !(await this._hasTrustedShareTrackingColumns())) return null;
    const { rows } = await domainDb.query(
      'identity',
      `UPDATE trusted_contacts_shares
       SET viewed_at = COALESCE(viewed_at, NOW()),
           delivery_status = CASE
             WHEN delivery_status IN ('pending', 'failed') THEN delivery_status
             ELSE 'viewed'
           END,
           updated_at = NOW()
       WHERE tracking_share_id = $1
       RETURNING id::text AS id`,
      [trackingShareId]
    );
    return rows;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _mapContact(row) {
    return {
      id:        row.id,
      name:      row.contact_name,
      relationship: row.relationship || '',
      number:    row.phone_number,
      isPrimary: row.is_primary,
    };
  }

  async _hasDeletedAtColumn() {
    if (this._hasEmergencyDeletedAt != null) return this._hasEmergencyDeletedAt;
    const { rows } = await domainDb.query('identity', 
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'emergency_contacts'
           AND column_name = 'deleted_at'
       ) AS "exists"`
    );
    this._hasEmergencyDeletedAt = Boolean(rows[0]?.exists);
    return this._hasEmergencyDeletedAt;
  }

  async _hasRelationshipColumn() {
    if (this._hasEmergencyRelationship != null) {
      return this._hasEmergencyRelationship;
    }
    const { rows } = await domainDb.query('identity', 
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'emergency_contacts'
           AND column_name = 'relationship'
       ) AS "exists"`
    );
    this._hasEmergencyRelationship = Boolean(rows[0]?.exists);
    return this._hasEmergencyRelationship;
  }

  async _activeContactWhere() {
    return (await this._hasDeletedAtColumn()) ? 'deleted_at IS NULL' : 'TRUE';
  }

  async _hasTrustedShareTrackingColumns() {
    if (this._hasShareTrackingColumns != null) return this._hasShareTrackingColumns;
    const { rows } = await domainDb.query(
      'identity',
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'trusted_contacts_shares'
           AND column_name = 'tracking_share_id'
       ) AS "exists"`
    );
    this._hasShareTrackingColumns = Boolean(rows[0]?.exists);
    return this._hasShareTrackingColumns;
  }
}

module.exports = new PgSafetyRepository();
