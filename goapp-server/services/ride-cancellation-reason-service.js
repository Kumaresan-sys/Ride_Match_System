'use strict';

const repo = require('../repositories/pg/pg-ride-cancellation-reason-repository');

class RideCancellationReasonService {
  async listReasons({ actorType = 'rider', userSelectableOnly = true } = {}) {
    return repo.list({ actorType, userSelectableOnly });
  }

  async resolveReason({
    actorType,
    reasonCode,
    note = null,
    displayText = null,
    fallbackCode = null,
  } = {}) {
    const normalizedActor = String(actorType || '').trim().toLowerCase();
    if (!normalizedActor) {
      throw new Error('actorType is required');
    }

    const normalizedCode = String(reasonCode || fallbackCode || '')
      .trim()
      .toUpperCase();
    if (!normalizedCode) {
      throw new Error(`reasonCode is required for actor '${normalizedActor}'`);
    }

    const reason = await repo.getByCode({
      actorType: normalizedActor,
      code: normalizedCode,
    });
    if (!reason) {
      throw new Error(
        `Unknown cancellation reason '${normalizedCode}' for actor '${normalizedActor}'`,
      );
    }

    const trimmedDisplayText = String(displayText || '').trim();
    const trimmedNote = String(note || '').trim();
    const reasonText = trimmedDisplayText
      ? trimmedDisplayText
      : (trimmedNote ? `${reason.title}: ${trimmedNote}` : reason.title);

    return {
      ...reason,
      reasonText,
      note: trimmedNote || null,
    };
  }
}

module.exports = new RideCancellationReasonService();
