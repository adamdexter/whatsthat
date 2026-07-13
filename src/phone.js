'use strict';

// Normalize a raw phone entry to E.164. Default country: US (+1).
// Returns { e164: '+14155550134', error: null } or { e164: null, error: 'reason' }.
function normalizePhone(raw, defaultCountryCode = '1') {
  if (raw == null || String(raw).trim() === '') return { e164: null, error: 'empty' };
  const s = String(raw).trim();
  const hasPlus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (digits.length === 0) return { e164: null, error: 'no digits' };

  if (hasPlus) {
    if (digits.length < 8 || digits.length > 15) {
      return { e164: null, error: `invalid international number (+${digits})` };
    }
    return { e164: `+${digits}`, error: null };
  }

  if (defaultCountryCode === '1') {
    if (digits.length === 10) return { e164: `+1${digits}`, error: null };
    if (digits.length === 11 && digits.startsWith('1')) return { e164: `+${digits}`, error: null };
    return {
      e164: null,
      error: `expected a 10-digit US number (or use +country code), got ${digits.length} digits`,
    };
  }

  if (digits.length >= 8 && digits.length <= 15) {
    return { e164: `+${defaultCountryCode}${digits}`, error: null };
  }
  return { e164: null, error: 'invalid number' };
}

module.exports = { normalizePhone };
