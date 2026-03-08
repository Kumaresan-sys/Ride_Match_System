'use strict';

const db = require('../../services/db');

class PgSafetyRepository {

  // ── Emergency Contacts ────────────────────────────────────────────────────

  /**
   * Returns all emergency contacts for a user, primary first then by name.
   */
  async getContacts(userId) {
    const { rows } = await db.query(
      `SELECT id::text, contact_name, phone_number, is_primary
       FROM emergency_contacts
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY is_primary DESC, contact_name ASC`,
      [userId]
    );
    return rows.map(this._mapContact);
  }

  /**
   * Adds a new emergency contact. At most 10 contacts per user.
   * If this is the first contact it becomes primary automatically.
   */
  async addContact(userId, { name, phoneNumber }) {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Enforce max 10 contacts
      const { rows: countRows } = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM emergency_contacts
         WHERE user_id = $1 AND deleted_at IS NULL`,
        [userId]
      );
      if (countRows[0].cnt >= 10) {
        const err = new Error('You can add at most 10 emergency contacts.');
        err.code = 'CONTACTS_LIMIT';
        throw err;
      }

      // First contact becomes primary
      const isPrimary = countRows[0].cnt === 0;

      const { rows } = await client.query(
        `INSERT INTO emergency_contacts (user_id, contact_name, phone_number, is_primary)
         VALUES ($1, $2, $3, $4)
         RETURNING id::text, contact_name, phone_number, is_primary`,
        [userId, name, phoneNumber, isPrimary]
      );

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
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Verify ownership
      const { rows: ownerRows } = await client.query(
        `SELECT id, is_primary FROM emergency_contacts
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [contactId, userId]
      );
      if (ownerRows.length === 0) {
        const err = new Error('Contact not found.');
        err.code = 'NOT_FOUND';
        throw err;
      }

      const wasPrimary = ownerRows[0].is_primary;

      await client.query(
        `UPDATE emergency_contacts SET deleted_at = NOW() WHERE id = $1`,
        [contactId]
      );

      // Promote oldest remaining contact to primary if needed
      if (wasPrimary) {
        await client.query(
          `UPDATE emergency_contacts SET is_primary = true
           WHERE id = (
             SELECT id FROM emergency_contacts
             WHERE user_id = $1 AND deleted_at IS NULL
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
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Verify ownership
      const { rows } = await client.query(
        `SELECT id FROM emergency_contacts
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
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
         WHERE user_id = $1 AND deleted_at IS NULL`,
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
  async updateContact(userId, contactId, { name, phoneNumber }) {
    const { rows } = await db.query(
      `UPDATE emergency_contacts
       SET contact_name = $3, phone_number = $4
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING id::text, contact_name, phone_number, is_primary`,
      [contactId, userId, name, phoneNumber]
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

    // Skip if this number already exists (active contact)
    const { rows: existing } = await db.query(
      `SELECT id FROM emergency_contacts
       WHERE user_id = $1 AND phone_number = $2 AND deleted_at IS NULL`,
      [userId, phone]
    );
    if (existing.length > 0) return;

    // Add as first contact (will auto-become primary if no others exist)
    await this.addContact(userId, { name: 'Emergency Contact', phoneNumber: phone });
  }

  // ── Safety Preferences ───────────────────────────────────────────────────

  /**
   * Returns safety preferences for a user (creates defaults if none exist).
   */
  async getPreferences(userId) {
    const { rows } = await db.query(
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
    const { rows } = await db.query(
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

  // ── Private ───────────────────────────────────────────────────────────────

  _mapContact(row) {
    return {
      id:        row.id,
      name:      row.contact_name,
      number:    row.phone_number,
      isPrimary: row.is_primary,
    };
  }
}

module.exports = new PgSafetyRepository();
