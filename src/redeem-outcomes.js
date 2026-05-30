export const REDEEM_OUTCOME = {
  REDEEMED: 'redeemed',
  ALREADY_REDEEMED: 'already redeemed',
  CAPTCHA: 'captcha',
  NOT_FOUND: 'not found',
  LOGIN_REQUIRED: 'login required',
  MANUAL_FOLLOW_UP: 'manual follow-up',
  UNKNOWN: 'unknown',
  ERROR: 'error',
  CONFIRMING: 'confirming',
  READY: 'ready',
};

const DEFAULT_ACTIONS = {
  [REDEEM_OUTCOME.REDEEMED]: 'redeemed',
  [REDEEM_OUTCOME.ALREADY_REDEEMED]: 'already redeemed',
  [REDEEM_OUTCOME.CAPTCHA]: 'redeem (got captcha)',
  [REDEEM_OUTCOME.NOT_FOUND]: 'redeem (not found)',
  [REDEEM_OUTCOME.LOGIN_REQUIRED]: 'redeem (login)',
  [REDEEM_OUTCOME.MANUAL_FOLLOW_UP]: 'redeem (manual backlog)',
  [REDEEM_OUTCOME.UNKNOWN]: 'redeem (unknown)',
  [REDEEM_OUTCOME.ERROR]: 'redeem (error)',
  [REDEEM_OUTCOME.CONFIRMING]: 'redeem (confirming)',
  [REDEEM_OUTCOME.READY]: 'redeem',
};

export const makeRedeemResult = (outcome, extra = {}) => ({
  outcome,
  redeem_action: extra.redeem_action || DEFAULT_ACTIONS[outcome] || DEFAULT_ACTIONS[REDEEM_OUTCOME.UNKNOWN],
  ...extra,
});

export const isConfirmedRedeemOutcome = outcome => [
  REDEEM_OUTCOME.REDEEMED,
  REDEEM_OUTCOME.ALREADY_REDEEMED,
].includes(outcome);

export const isCaptchaRedeemOutcome = outcome => outcome == REDEEM_OUTCOME.CAPTCHA;

const reasonText = json => `${json?.reason || json?.reason2 || ''}`.toLowerCase();

export const classifyGogLookupResponse = json => {
  if (!json || typeof json != 'object') return makeRedeemResult(REDEEM_OUTCOME.UNKNOWN);

  const reason = reasonText(json);
  if (reason.includes('captcha')) return makeRedeemResult(REDEEM_OUTCOME.CAPTCHA, { reason: json.reason || json.reason2 });
  if (reason == 'code_used') return makeRedeemResult(REDEEM_OUTCOME.ALREADY_REDEEMED, { reason });
  if (reason == 'code_not_found') return makeRedeemResult(REDEEM_OUTCOME.NOT_FOUND, { reason });
  if (Array.isArray(json.products) && json.products.length) {
    return makeRedeemResult(REDEEM_OUTCOME.READY, {
      productTitle: json.products[0]?.title,
    });
  }

  return makeRedeemResult(REDEEM_OUTCOME.UNKNOWN);
};

export const classifyGogRedeemResponse = json => {
  if (!json || typeof json != 'object') return makeRedeemResult(REDEEM_OUTCOME.UNKNOWN);

  const reason = reasonText(json);
  if (reason.includes('captcha')) return makeRedeemResult(REDEEM_OUTCOME.CAPTCHA, { reason: json.reason || json.reason2 });
  if (reason == 'code_used') return makeRedeemResult(REDEEM_OUTCOME.ALREADY_REDEEMED, { reason });
  if (reason == 'code_not_found') return makeRedeemResult(REDEEM_OUTCOME.NOT_FOUND, { reason });
  if (json.type == 'async_processing') return makeRedeemResult(REDEEM_OUTCOME.CONFIRMING);

  return makeRedeemResult(REDEEM_OUTCOME.UNKNOWN);
};

export const classifyGogPageText = text => {
  const normalized = `${text || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return makeRedeemResult(REDEEM_OUTCOME.UNKNOWN);
  if ((/code redeemed successfully|successfully added .* to your gog account/).test(normalized)) return makeRedeemResult(REDEEM_OUTCOME.REDEEMED);
  if ((/already (been )?(redeemed|used)|code (has )?already|code_used/).test(normalized)) return makeRedeemResult(REDEEM_OUTCOME.ALREADY_REDEEMED);
  if ((/code_not_found|code (was )?not found|invalid code|code is invalid|does not exist|expired/).test(normalized)) return makeRedeemResult(REDEEM_OUTCOME.NOT_FOUND);
  if ((/captcha|not a robot|invalid or no captcha/).test(normalized)) return makeRedeemResult(REDEEM_OUTCOME.CAPTCHA);
  if ((/log in|sign in|email.*password/).test(normalized)) return makeRedeemResult(REDEEM_OUTCOME.LOGIN_REQUIRED);

  return makeRedeemResult(REDEEM_OUTCOME.UNKNOWN);
};

export const classifyLegacyPageText = text => {
  const normalized = `${text || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return makeRedeemResult(REDEEM_OUTCOME.UNKNOWN);
  if ((/thanks for redeeming|redemption successful|successfully redeemed|your game has been redeemed/).test(normalized)) return makeRedeemResult(REDEEM_OUTCOME.REDEEMED);
  if ((/already (been )?(redeemed|used)|coupon has already|code has already/).test(normalized)) return makeRedeemResult(REDEEM_OUTCOME.ALREADY_REDEEMED);
  if ((/invalid coupon|invalid code|code is invalid|not valid|not found|couldn'?t be found|page not found|\b404\b|does not exist|expired/).test(normalized)) return makeRedeemResult(REDEEM_OUTCOME.NOT_FOUND);
  if ((/captcha|not a robot/).test(normalized)) return makeRedeemResult(REDEEM_OUTCOME.CAPTCHA);
  if ((/log in|sign in/).test(normalized)) return makeRedeemResult(REDEEM_OUTCOME.LOGIN_REQUIRED);
  if ((/error|problem|try again/).test(normalized)) return makeRedeemResult(REDEEM_OUTCOME.ERROR);

  return makeRedeemResult(REDEEM_OUTCOME.UNKNOWN);
};
