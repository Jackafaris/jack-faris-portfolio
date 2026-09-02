// Shared types for the market trackers (client side), mirroring /api/trackers.

export interface TrackerPoint {
  date: string; // YYYY-MM-DD
  close: number;
}

export interface Tracker {
  symbol: string;
  name: string;
  base: TrackerPoint; // the "as of" starting point
  history: TrackerPoint[]; // includes base, ascending by date
}

export interface TrackerSummary {
  symbol: string;
  name: string;
  base: TrackerPoint;
  last: TrackerPoint;
  dailyPct: number; // % change vs previous close
  totalPct: number; // % change vs base point
}

export interface TrackersBody {
  version: number;
  tracks: Tracker[];
  updatedAt: string;
  summary?: TrackerSummary[];
}
