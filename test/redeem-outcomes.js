import assert from 'node:assert/strict';
import {
  REDEEM_OUTCOME,
  classifyGogLookupResponse,
  classifyGogPageText,
  classifyGogRedeemResponse,
  classifyLegacyPageText,
  isConfirmedRedeemOutcome,
} from '../src/redeem-outcomes.js';

assert.equal(classifyGogLookupResponse({ reason: 'Invalid or no captcha' }).outcome, REDEEM_OUTCOME.CAPTCHA);
assert.equal(classifyGogLookupResponse({ reason: 'code_used' }).outcome, REDEEM_OUTCOME.ALREADY_REDEEMED);
assert.equal(classifyGogLookupResponse({ reason: 'code_not_found' }).outcome, REDEEM_OUTCOME.NOT_FOUND);
assert.equal(classifyGogLookupResponse({ products: [{ title: 'Mahokenshi - Amazon Luna' }] }).outcome, REDEEM_OUTCOME.READY);

assert.equal(classifyGogRedeemResponse({ type: 'async_processing', checkoutUrl: null }).outcome, REDEEM_OUTCOME.CONFIRMING);
assert.equal(classifyGogRedeemResponse({ reason2: 'Invalid or no captcha' }).outcome, REDEEM_OUTCOME.CAPTCHA);

assert.equal(classifyGogPageText('Code redeemed successfully! Great news!').outcome, REDEEM_OUTCOME.REDEEMED);
assert.equal(classifyGogPageText('This code has already been used.').outcome, REDEEM_OUTCOME.ALREADY_REDEEMED);
assert.equal(classifyGogPageText('Code was not found.').outcome, REDEEM_OUTCOME.NOT_FOUND);
assert.equal(classifyGogPageText('Please log in to continue.').outcome, REDEEM_OUTCOME.LOGIN_REQUIRED);

assert.equal(classifyLegacyPageText('Thanks for redeeming.').outcome, REDEEM_OUTCOME.REDEEMED);
assert.equal(classifyLegacyPageText('This coupon has already been redeemed.').outcome, REDEEM_OUTCOME.ALREADY_REDEEMED);
assert.equal(classifyLegacyPageText('Invalid coupon code.').outcome, REDEEM_OUTCOME.NOT_FOUND);
assert.equal(classifyLegacyPageText('404 Ooops. The page you were looking for couldn\'t be found.').outcome, REDEEM_OUTCOME.NOT_FOUND);
assert.equal(classifyLegacyPageText('There was a problem. Please try again.').outcome, REDEEM_OUTCOME.ERROR);

assert.equal(isConfirmedRedeemOutcome(REDEEM_OUTCOME.REDEEMED), true);
assert.equal(isConfirmedRedeemOutcome(REDEEM_OUTCOME.CAPTCHA), false);

console.log('redeem-outcomes ok');
