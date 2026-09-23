/**
 * Public landing entry point.
 *
 * The Conversation Stage implementation lives in `marketing/` so the whole
 * public site can be reviewed as one unit. This file keeps the existing `Home`
 * export used by `App.tsx` and by the historical route table.
 */
export { default as Home } from './marketing/MarketingSite';
