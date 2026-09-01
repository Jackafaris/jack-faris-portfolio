// Public surface of the investing lib — the page imports from here.
export { Board, PALETTE } from './board';
export type { BoardDeps } from './board';
export { ApiError, fetchPrice, picksAction, picksGet } from './api';
export type { PickExtra, PicksAction } from './api';
export { usd0, usd2, fmtPct, fmtDate, esc, errMsg } from './format';
export { pctSince, summaryData, earliestBuyDate } from './maths';
export { summaryHtml, legendHtml, tableRowsHtml } from './rows';
export { buildSeries, computeScales, drawChart } from './chart';
export type { Series, Scales, DrawOpts } from './chart';
export type { Position, PriceData, PricePoint, LineEntry, Lines, PicksBody } from './types';
