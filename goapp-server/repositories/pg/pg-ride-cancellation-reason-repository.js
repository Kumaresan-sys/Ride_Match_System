'use strict';

const domainDb = require('../../infra/db/domain-db');

class PgRideCancellationReasonRepository {
  async list({ actorType, userSelectableOnly = true } = {}) {
    const values = [];
    const where = ['is_active = true'];

    if (actorType) {
      values.push(actorType);
      where.push(`actor_type = $${values.length}`);
    }

    if (userSelectableOnly) {
      where.push('is_user_selectable = true');
    }

    const { rows } = await domainDb.query(
      'rides',
      `SELECT
         id,
         actor_type AS "actorType",
         code,
         title,
         description,
         requires_note AS "requiresNote",
         is_user_selectable AS "isUserSelectable",
         sort_order AS "sortOrder"
       FROM ride_cancellation_reasons
       WHERE ${where.join(' AND ')}
       ORDER BY sort_order ASC, created_at ASC`,
      values
    );

    return rows;
  }

  async getByCode({ actorType, code }, client = null) {
    if (!actorType || !code) return null;
    const sql = `SELECT
        id,
        actor_type AS "actorType",
        code,
        title,
        description,
        requires_note AS "requiresNote",
        is_user_selectable AS "isUserSelectable",
        sort_order AS "sortOrder"
      FROM ride_cancellation_reasons
      WHERE actor_type = $1
        AND code = $2
        AND is_active = true
      LIMIT 1`;
    const { rows } = client
      ? await client.query(sql, [actorType, code])
      : await domainDb.query('rides', sql, [actorType, code]);
    return rows[0] || null;
  }
}

module.exports = new PgRideCancellationReasonRepository();
