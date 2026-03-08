'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');

const JWT_SECRET = config.security.jwt.secret;
const JWT_ISSUER = config.security.jwt.issuer;
const JWT_AUDIENCE = config.security.jwt.audience;

function signAccessToken({ sessionToken, userId, expiresInSec }) {
  if (!JWT_SECRET) {
    throw new Error('JWT secret is not configured');
  }
  return jwt.sign(
    {
      sub: String(userId),
      sid: String(sessionToken),
      typ: 'access',
    },
    JWT_SECRET,
    {
      algorithm: 'HS256',
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      expiresIn: expiresInSec,
    },
  );
}

function verifyAccessToken(token) {
  if (!token || !JWT_SECRET) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    if (!payload || payload.typ !== 'access' || !payload.sid || !payload.sub) {
      return null;
    }
    return {
      userId: String(payload.sub),
      sessionToken: String(payload.sid),
      exp: payload.exp,
    };
  } catch (_) {
    return null;
  }
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
};
