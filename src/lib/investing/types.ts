// Shared types for the Jack's Picks board (client side).
// Mirrors the wire shape of /api/picks and /api/stock-price.

export interface Position {
  id: string;
  symbol: string;
  name: string;
  price: number;
  /** Buy date, YYYY-MM-DD */
  date: string;
  shares: number;
  note: string;
}

export interface PricePoint {
  /** YYYY-MM-DD */
  date: string;
  close: number;
}

export interface PriceData {
  symbol: string;
  name: string;
  currency: string;
  price: number;
  dayChangePct: number | null;
  /** Epoch seconds */
  marketTime: number;
  history: PricePoint[];
}

export interface LineEntry {
  color: string;
  data: PriceData | null;
  error: string;
}

export type Lines = Map<string, LineEntry>;

export interface PicksBody {
  positions: Position[];
}
