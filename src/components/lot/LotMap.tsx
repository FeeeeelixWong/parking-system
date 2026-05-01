"use client";

import React, { useState, useCallback, useEffect, useMemo } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// View-layer occupancy toggle for the lot editor/preview. NOT a DB column —
// the DB derives "is this spot taken" from the Session table (see docs/DATA_MODEL.md).
export type SpotStatus = "AVAILABLE" | "OCCUPIED";

export type SpotData = {
  id: string;
  label: string;
  type: "BOBTAIL" | "TRUCK_TRAILER";
  status: SpotStatus;
  vehicle?: {
    unitNumber?: string;
    licensePlate?: string;
    nickname?: string;
  };
  driverName?: string;
};

export type LabelSuggestion = { spotId: string; label: string };

type LotMapProps = {
  spots: SpotData[];
  onSpotClick?: (spot: SpotData) => void;
  selectedSpotId?: string | null;
  /** Custom label overrides: spotId → display label */
  labelOverrides?: Record<string, string>;
  /** Called when user double-clicks a spot and edits its label */
  onLabelChange?: (spotId: string, newLabel: string) => void;
  /** Pending suggestions to highlight on the map */
  suggestions?: LabelSuggestion[];
};

// ---------------------------------------------------------------------------
// Spot layout from DXF CAD data
// ---------------------------------------------------------------------------

export type SpotLayout = {
  id: string;
  label: string;
  type: "BOBTAIL" | "TRUCK_TRAILER";
  cx: number;
  cy: number;
  w: number;
  h: number;
  rot: number;
};

// All 133 spots from Onshape DXF, transformed to SVG coordinates.
// Border bbox: x -75..75, y -90.85..90.85 → SVG 0..1000 x 0..1211
// Scale: 6.5333, Y flipped.
export const CAD_SPOTS: SpotLayout[] = [
  // ── West column: 28 truck spots (horizontal, rot=0) ──
  { id: "T1", label: "1", type: "TRUCK_TRAILER", cx: 97.7, cy: 931.7, w: 149.1, h: 19.6, rot: 0 },
  { id: "T2", label: "2", type: "TRUCK_TRAILER", cx: 97.7, cy: 909.2, w: 149.1, h: 19.6, rot: 0 },
  { id: "T3", label: "3", type: "TRUCK_TRAILER", cx: 97.7, cy: 886.6, w: 149.1, h: 19.6, rot: 0 },
  { id: "T4", label: "4", type: "TRUCK_TRAILER", cx: 97.7, cy: 864.1, w: 149.1, h: 19.6, rot: 0 },
  { id: "T5", label: "5", type: "TRUCK_TRAILER", cx: 97.7, cy: 841.6, w: 149.1, h: 19.6, rot: 0 },
  { id: "T6", label: "6", type: "TRUCK_TRAILER", cx: 97.7, cy: 819.0, w: 149.1, h: 19.6, rot: 0 },
  { id: "T7", label: "7", type: "TRUCK_TRAILER", cx: 97.7, cy: 796.5, w: 149.1, h: 19.6, rot: 0 },
  { id: "T8", label: "8", type: "TRUCK_TRAILER", cx: 97.7, cy: 773.9, w: 149.1, h: 19.6, rot: 0 },
  { id: "T9", label: "9", type: "TRUCK_TRAILER", cx: 97.7, cy: 751.4, w: 149.1, h: 19.6, rot: 0 },
  { id: "T10", label: "10", type: "TRUCK_TRAILER", cx: 97.7, cy: 728.9, w: 149.1, h: 19.6, rot: 0 },
  { id: "T11", label: "11", type: "TRUCK_TRAILER", cx: 97.7, cy: 706.3, w: 149.1, h: 19.6, rot: 0 },
  { id: "T12", label: "12", type: "TRUCK_TRAILER", cx: 97.7, cy: 683.8, w: 149.1, h: 19.6, rot: 0 },
  { id: "T13", label: "13", type: "TRUCK_TRAILER", cx: 97.7, cy: 661.2, w: 149.1, h: 19.6, rot: 0 },
  { id: "T14", label: "14", type: "TRUCK_TRAILER", cx: 97.7, cy: 638.7, w: 149.1, h: 19.6, rot: 0 },
  { id: "T15", label: "15", type: "TRUCK_TRAILER", cx: 97.7, cy: 616.2, w: 149.1, h: 19.6, rot: 0 },
  { id: "T16", label: "16", type: "TRUCK_TRAILER", cx: 97.7, cy: 593.6, w: 149.1, h: 19.6, rot: 0 },
  { id: "T17", label: "17", type: "TRUCK_TRAILER", cx: 97.7, cy: 571.1, w: 149.1, h: 19.6, rot: 0 },
  { id: "T18", label: "18", type: "TRUCK_TRAILER", cx: 97.7, cy: 548.5, w: 149.1, h: 19.6, rot: 0 },
  { id: "T19", label: "19", type: "TRUCK_TRAILER", cx: 97.7, cy: 526.0, w: 149.1, h: 19.6, rot: 0 },
  { id: "T20", label: "20", type: "TRUCK_TRAILER", cx: 97.7, cy: 503.5, w: 149.1, h: 19.6, rot: 0 },
  { id: "T21", label: "21", type: "TRUCK_TRAILER", cx: 97.7, cy: 480.9, w: 149.1, h: 19.6, rot: 0 },
  { id: "T22", label: "22", type: "TRUCK_TRAILER", cx: 97.7, cy: 458.4, w: 149.1, h: 19.6, rot: 0 },
  { id: "T23", label: "23", type: "TRUCK_TRAILER", cx: 97.7, cy: 435.8, w: 149.1, h: 19.6, rot: 0 },
  { id: "T24", label: "24", type: "TRUCK_TRAILER", cx: 97.7, cy: 413.3, w: 149.1, h: 19.6, rot: 0 },
  { id: "T25", label: "25", type: "TRUCK_TRAILER", cx: 97.7, cy: 390.8, w: 149.1, h: 19.6, rot: 0 },
  { id: "T26", label: "26", type: "TRUCK_TRAILER", cx: 97.7, cy: 368.2, w: 149.1, h: 19.6, rot: 0 },
  { id: "T27", label: "27", type: "TRUCK_TRAILER", cx: 97.7, cy: 345.7, w: 149.1, h: 19.6, rot: 0 },
  { id: "T28", label: "28", type: "TRUCK_TRAILER", cx: 97.7, cy: 323.1, w: 149.1, h: 19.6, rot: 0 },

  // ── West column upper: 12 bobtail spots (horizontal, rot=0) ──
  { id: "B1", label: "B1", type: "BOBTAIL", cx: 60.5, cy: 291.5, w: 74.5, h: 19.6, rot: 0 },
  { id: "B2", label: "B2", type: "BOBTAIL", cx: 60.5, cy: 268.7, w: 74.5, h: 19.6, rot: 0 },
  { id: "B3", label: "B3", type: "BOBTAIL", cx: 60.5, cy: 245.8, w: 74.5, h: 19.6, rot: 0 },
  { id: "B4", label: "B4", type: "BOBTAIL", cx: 60.5, cy: 222.9, w: 74.5, h: 19.6, rot: 0 },
  { id: "B5", label: "B5", type: "BOBTAIL", cx: 60.5, cy: 200.1, w: 74.5, h: 19.6, rot: 0 },
  { id: "B6", label: "B6", type: "BOBTAIL", cx: 60.5, cy: 177.2, w: 74.5, h: 19.6, rot: 0 },
  { id: "B7", label: "B7", type: "BOBTAIL", cx: 60.5, cy: 154.3, w: 74.5, h: 19.6, rot: 0 },
  { id: "B8", label: "B8", type: "BOBTAIL", cx: 60.5, cy: 131.5, w: 74.5, h: 19.6, rot: 0 },
  { id: "B9", label: "B9", type: "BOBTAIL", cx: 60.5, cy: 108.6, w: 74.5, h: 19.6, rot: 0 },
  { id: "B10", label: "B10", type: "BOBTAIL", cx: 60.5, cy: 85.7, w: 74.5, h: 19.6, rot: 0 },
  { id: "B11", label: "B11", type: "BOBTAIL", cx: 60.5, cy: 62.9, w: 74.5, h: 19.6, rot: 0 },

  // ── Center-left rows: truck spots (horizontal, rot=0) ──
  { id: "T29", label: "29", type: "TRUCK_TRAILER", cx: 383.6, cy: 907.5, w: 149.1, h: 19.6, rot: 0 },
  { id: "T30", label: "30", type: "TRUCK_TRAILER", cx: 383.6, cy: 885.3, w: 149.1, h: 19.6, rot: 0 },
  { id: "T31", label: "31", type: "TRUCK_TRAILER", cx: 383.6, cy: 863.1, w: 149.1, h: 19.6, rot: 0 },
  { id: "T32", label: "32", type: "TRUCK_TRAILER", cx: 383.6, cy: 840.8, w: 149.1, h: 19.6, rot: 0 },
  { id: "T33", label: "33", type: "TRUCK_TRAILER", cx: 383.6, cy: 818.6, w: 149.1, h: 19.6, rot: 0 },
  { id: "T34", label: "34", type: "TRUCK_TRAILER", cx: 383.6, cy: 796.4, w: 149.1, h: 19.6, rot: 0 },
  { id: "T35", label: "35", type: "TRUCK_TRAILER", cx: 383.6, cy: 774.2, w: 149.1, h: 19.6, rot: 0 },
  { id: "T36", label: "36", type: "TRUCK_TRAILER", cx: 383.6, cy: 752.0, w: 149.1, h: 19.6, rot: 0 },
  { id: "T37", label: "37", type: "TRUCK_TRAILER", cx: 383.6, cy: 729.8, w: 149.1, h: 19.6, rot: 0 },
  { id: "T38", label: "38", type: "TRUCK_TRAILER", cx: 383.6, cy: 707.6, w: 149.1, h: 19.6, rot: 0 },
  { id: "T39", label: "39", type: "TRUCK_TRAILER", cx: 383.6, cy: 685.3, w: 149.1, h: 19.6, rot: 0 },
  { id: "T40", label: "40", type: "TRUCK_TRAILER", cx: 383.6, cy: 663.1, w: 149.1, h: 19.6, rot: 0 },
  { id: "T41", label: "41", type: "TRUCK_TRAILER", cx: 383.6, cy: 640.9, w: 149.1, h: 19.6, rot: 0 },
  { id: "T42", label: "42", type: "TRUCK_TRAILER", cx: 383.6, cy: 618.7, w: 149.1, h: 19.6, rot: 0 },
  { id: "T43", label: "43", type: "TRUCK_TRAILER", cx: 383.6, cy: 596.5, w: 149.1, h: 19.6, rot: 0 },
  { id: "T44", label: "44", type: "TRUCK_TRAILER", cx: 383.6, cy: 574.3, w: 149.1, h: 19.6, rot: 0 },
  { id: "T45", label: "45", type: "TRUCK_TRAILER", cx: 383.6, cy: 552.1, w: 149.1, h: 19.6, rot: 0 },
  { id: "T46", label: "46", type: "TRUCK_TRAILER", cx: 383.6, cy: 529.9, w: 149.1, h: 19.6, rot: 0 },

  // ── Center-right rows: truck spots (horizontal, rot=0) ──
  { id: "T47", label: "47", type: "TRUCK_TRAILER", cx: 538.0, cy: 907.5, w: 149.1, h: 19.6, rot: 0 },
  { id: "T48", label: "48", type: "TRUCK_TRAILER", cx: 538.0, cy: 885.3, w: 149.1, h: 19.6, rot: 0 },
  { id: "T49", label: "49", type: "TRUCK_TRAILER", cx: 538.0, cy: 863.1, w: 149.1, h: 19.6, rot: 0 },
  { id: "T50", label: "50", type: "TRUCK_TRAILER", cx: 538.0, cy: 840.8, w: 149.1, h: 19.6, rot: 0 },
  { id: "T51", label: "51", type: "TRUCK_TRAILER", cx: 538.0, cy: 818.6, w: 149.1, h: 19.6, rot: 0 },
  { id: "T52", label: "52", type: "TRUCK_TRAILER", cx: 538.0, cy: 796.4, w: 149.1, h: 19.6, rot: 0 },
  { id: "T53", label: "53", type: "TRUCK_TRAILER", cx: 538.0, cy: 774.2, w: 149.1, h: 19.6, rot: 0 },
  { id: "T54", label: "54", type: "TRUCK_TRAILER", cx: 538.0, cy: 752.0, w: 149.1, h: 19.6, rot: 0 },
  { id: "T55", label: "55", type: "TRUCK_TRAILER", cx: 538.0, cy: 729.8, w: 149.1, h: 19.6, rot: 0 },
  { id: "T56", label: "56", type: "TRUCK_TRAILER", cx: 538.0, cy: 707.6, w: 149.1, h: 19.6, rot: 0 },
  { id: "T57", label: "57", type: "TRUCK_TRAILER", cx: 538.0, cy: 685.3, w: 149.1, h: 19.6, rot: 0 },
  { id: "T58", label: "58", type: "TRUCK_TRAILER", cx: 538.0, cy: 663.1, w: 149.1, h: 19.6, rot: 0 },

  // ── Center-right bobtail (3 spots at end of center rows) ──
  { id: "B12", label: "B12", type: "BOBTAIL", cx: 500.7, cy: 640.9, w: 74.5, h: 19.6, rot: 0 },
  { id: "B13", label: "B13", type: "BOBTAIL", cx: 500.7, cy: 618.7, w: 74.5, h: 19.6, rot: 0 },
  { id: "B14", label: "B14", type: "BOBTAIL", cx: 500.7, cy: 596.5, w: 74.5, h: 19.6, rot: 0 },

  // ── East column: truck spots (horizontal, rot=0) ──
  { id: "T59", label: "59", type: "TRUCK_TRAILER", cx: 906.4, cy: 976.4, w: 149.1, h: 19.6, rot: 0 },
  { id: "T60", label: "60", type: "TRUCK_TRAILER", cx: 906.4, cy: 953.2, w: 149.1, h: 19.6, rot: 0 },
  { id: "T61", label: "61", type: "TRUCK_TRAILER", cx: 906.4, cy: 930.0, w: 149.1, h: 19.6, rot: 0 },
  { id: "T62", label: "62", type: "TRUCK_TRAILER", cx: 906.4, cy: 906.8, w: 149.1, h: 19.6, rot: 0 },
  { id: "T63", label: "63", type: "TRUCK_TRAILER", cx: 906.4, cy: 883.6, w: 149.1, h: 19.6, rot: 0 },
  { id: "T64", label: "64", type: "TRUCK_TRAILER", cx: 906.4, cy: 860.4, w: 149.1, h: 19.6, rot: 0 },
  { id: "T65", label: "65", type: "TRUCK_TRAILER", cx: 906.4, cy: 837.2, w: 149.1, h: 19.6, rot: 0 },
  { id: "T66", label: "66", type: "TRUCK_TRAILER", cx: 906.4, cy: 814.1, w: 149.1, h: 19.6, rot: 0 },
  { id: "T67", label: "67", type: "TRUCK_TRAILER", cx: 906.4, cy: 790.9, w: 149.1, h: 19.6, rot: 0 },
  { id: "T68", label: "68", type: "TRUCK_TRAILER", cx: 906.4, cy: 767.7, w: 149.1, h: 19.6, rot: 0 },
  { id: "T69", label: "69", type: "TRUCK_TRAILER", cx: 906.4, cy: 744.5, w: 149.1, h: 19.6, rot: 0 },
  { id: "T70", label: "70", type: "TRUCK_TRAILER", cx: 906.4, cy: 721.3, w: 149.1, h: 19.6, rot: 0 },
  { id: "T71", label: "71", type: "TRUCK_TRAILER", cx: 906.4, cy: 698.1, w: 149.1, h: 19.6, rot: 0 },
  { id: "T72", label: "72", type: "TRUCK_TRAILER", cx: 906.4, cy: 674.9, w: 149.1, h: 19.6, rot: 0 },
  { id: "T73", label: "73", type: "TRUCK_TRAILER", cx: 906.4, cy: 651.7, w: 149.1, h: 19.6, rot: 0 },

  // ── South row: vertical spots (rot=90) ──
  // 2 bobtail + 12 truck along bottom edge
  { id: "B15", label: "B15", type: "BOBTAIL", cx: 174.8, cy: 1144.6, w: 74.5, h: 19.6, rot: 90 },
  { id: "B16", label: "B16", type: "BOBTAIL", cx: 197.6, cy: 1144.6, w: 74.5, h: 19.6, rot: 90 },
  { id: "T74", label: "74", type: "TRUCK_TRAILER", cx: 220.5, cy: 1107.3, w: 149.1, h: 19.6, rot: 90 },
  { id: "T75", label: "75", type: "TRUCK_TRAILER", cx: 243.4, cy: 1107.3, w: 149.1, h: 19.6, rot: 90 },
  { id: "T76", label: "76", type: "TRUCK_TRAILER", cx: 266.2, cy: 1107.3, w: 149.1, h: 19.6, rot: 90 },
  { id: "T77", label: "77", type: "TRUCK_TRAILER", cx: 289.1, cy: 1107.3, w: 149.1, h: 19.6, rot: 90 },
  { id: "T78", label: "78", type: "TRUCK_TRAILER", cx: 312.0, cy: 1107.3, w: 149.1, h: 19.6, rot: 90 },
  { id: "T79", label: "79", type: "TRUCK_TRAILER", cx: 334.8, cy: 1107.3, w: 149.1, h: 19.6, rot: 90 },
  { id: "T80", label: "80", type: "TRUCK_TRAILER", cx: 357.7, cy: 1107.3, w: 149.1, h: 19.6, rot: 90 },
  { id: "T81", label: "81", type: "TRUCK_TRAILER", cx: 380.6, cy: 1107.3, w: 149.1, h: 19.6, rot: 90 },
  { id: "T82", label: "82", type: "TRUCK_TRAILER", cx: 403.4, cy: 1107.3, w: 149.1, h: 19.6, rot: 90 },
  { id: "T83", label: "83", type: "TRUCK_TRAILER", cx: 426.3, cy: 1107.3, w: 149.1, h: 19.6, rot: 90 },
  { id: "T84", label: "84", type: "TRUCK_TRAILER", cx: 449.2, cy: 1107.3, w: 149.1, h: 19.6, rot: 90 },
  { id: "T85", label: "85", type: "TRUCK_TRAILER", cx: 472.0, cy: 1107.3, w: 149.1, h: 19.6, rot: 90 },

  // ── East-lower bobtail (vertical, rot=90) ──
  { id: "B17", label: "B17", type: "BOBTAIL", cx: 663.7, cy: 577.0, w: 58.8, h: 19.6, rot: 90 },
  { id: "B18", label: "B18", type: "BOBTAIL", cx: 686.6, cy: 577.0, w: 58.8, h: 19.6, rot: 90 },
  { id: "B19", label: "B19", type: "BOBTAIL", cx: 709.5, cy: 577.0, w: 58.8, h: 19.6, rot: 90 },
  { id: "B20", label: "B20", type: "BOBTAIL", cx: 732.3, cy: 577.0, w: 58.8, h: 19.6, rot: 90 },
  { id: "B21", label: "B21", type: "BOBTAIL", cx: 755.2, cy: 577.0, w: 58.8, h: 19.6, rot: 90 },

  // ── Diagonal bobtail strip: lower section (rot=-46.5) ──
  { id: "B22", label: "B22", type: "BOBTAIL", cx: 183.0, cy: 135.0, w: 58.8, h: 19.6, rot: -46.5 },
  { id: "B23", label: "B23", type: "BOBTAIL", cx: 199.6, cy: 150.8, w: 58.8, h: 19.6, rot: -46.5 },
  { id: "B24", label: "B24", type: "BOBTAIL", cx: 216.2, cy: 166.5, w: 58.8, h: 19.6, rot: -46.5 },
  { id: "B25", label: "B25", type: "BOBTAIL", cx: 232.8, cy: 182.2, w: 58.8, h: 19.6, rot: -46.5 },
  { id: "B26", label: "B26", type: "BOBTAIL", cx: 249.4, cy: 198.0, w: 58.8, h: 19.6, rot: -46.5 },
  { id: "B27", label: "B27", type: "BOBTAIL", cx: 266.0, cy: 213.7, w: 58.8, h: 19.6, rot: -46.5 },
  { id: "B28", label: "B28", type: "BOBTAIL", cx: 282.6, cy: 229.5, w: 58.8, h: 19.6, rot: -46.5 },
  { id: "B29", label: "B29", type: "BOBTAIL", cx: 299.2, cy: 245.2, w: 58.8, h: 19.6, rot: -46.5 },
  { id: "B30", label: "B30", type: "BOBTAIL", cx: 315.8, cy: 260.9, w: 58.8, h: 19.6, rot: -46.5 },
  { id: "B31", label: "B31", type: "BOBTAIL", cx: 332.4, cy: 276.6, w: 58.8, h: 19.6, rot: -46.5 },
  { id: "B32", label: "B32", type: "BOBTAIL", cx: 349.0, cy: 292.4, w: 58.8, h: 19.6, rot: -46.5 },
  { id: "B33", label: "B33", type: "BOBTAIL", cx: 365.6, cy: 308.1, w: 58.8, h: 19.6, rot: -46.5 },

  // ── Diagonal bobtail strip: upper section (rot=-48.5) ──
  { id: "B34", label: "B34", type: "BOBTAIL", cx: 385.3, cy: 350.9, w: 58.8, h: 19.6, rot: -48.5 },
  { id: "B35", label: "B35", type: "BOBTAIL", cx: 402.5, cy: 366.1, w: 58.8, h: 19.6, rot: -48.5 },
  { id: "B36", label: "B36", type: "BOBTAIL", cx: 419.6, cy: 381.2, w: 58.8, h: 19.6, rot: -48.5 },
  { id: "B37", label: "B37", type: "BOBTAIL", cx: 436.8, cy: 396.4, w: 58.8, h: 19.6, rot: -48.5 },
  { id: "B38", label: "B38", type: "BOBTAIL", cx: 453.9, cy: 411.5, w: 58.8, h: 19.6, rot: -48.5 },
  { id: "B39", label: "B39", type: "BOBTAIL", cx: 471.0, cy: 426.6, w: 58.8, h: 19.6, rot: -48.5 },
  { id: "B40", label: "B40", type: "BOBTAIL", cx: 488.1, cy: 441.8, w: 58.8, h: 19.6, rot: -48.5 },
  { id: "B41", label: "B41", type: "BOBTAIL", cx: 505.2, cy: 456.9, w: 58.8, h: 19.6, rot: -48.5 },
  { id: "B42", label: "B42", type: "BOBTAIL", cx: 522.4, cy: 472.1, w: 58.8, h: 19.6, rot: -48.5 },
  { id: "B43", label: "B43", type: "BOBTAIL", cx: 539.5, cy: 487.3, w: 58.8, h: 19.6, rot: -48.5 },
  { id: "B44", label: "B44", type: "BOBTAIL", cx: 556.6, cy: 502.4, w: 58.8, h: 19.6, rot: -48.5 },
  { id: "B45", label: "B45", type: "BOBTAIL", cx: 573.8, cy: 517.6, w: 58.8, h: 19.6, rot: -48.5 },
  { id: "B46", label: "B46", type: "BOBTAIL", cx: 590.9, cy: 532.7, w: 58.8, h: 19.6, rot: -48.5 },
  { id: "B47", label: "B47", type: "BOBTAIL", cx: 608.0, cy: 547.8, w: 58.8, h: 19.6, rot: -48.5 },
  { id: "B48", label: "B48", type: "BOBTAIL", cx: 625.2, cy: 563.0, w: 58.8, h: 19.6, rot: -48.5 },
];

// ---------------------------------------------------------------------------
// Spot sequence groups — defines which spots form a natural sequence
// Order within each group is the labeling order (first = label 1, etc.)
// ---------------------------------------------------------------------------
export const SPOT_GROUPS: string[][] = [
  // West column: T1–T28 (bottom to top)
  ["T1","T2","T3","T4","T5","T6","T7","T8","T9","T10","T11","T12","T13","T14","T15","T16","T17","T18","T19","T20","T21","T22","T23","T24","T25","T26","T27","T28"],
  // West upper bobtail: B1–B11
  ["B1","B2","B3","B4","B5","B6","B7","B8","B9","B10","B11"],
  // Center-left rows: T29–T46
  ["T29","T30","T31","T32","T33","T34","T35","T36","T37","T38","T39","T40","T41","T42","T43","T44","T45","T46"],
  // Center-right rows: T47–T58
  ["T47","T48","T49","T50","T51","T52","T53","T54","T55","T56","T57","T58"],
  // Center-right bobtail: B12–B14
  ["B12","B13","B14"],
  // East column: T59–T73
  ["T59","T60","T61","T62","T63","T64","T65","T66","T67","T68","T69","T70","T71","T72","T73"],
  // South row bobtail: B15, B16
  ["B15","B16"],
  // South row truck: T74–T85
  ["T74","T75","T76","T77","T78","T79","T80","T81","T82","T83","T84","T85"],
  // East-lower bobtail: B17–B21
  ["B17","B18","B19","B20","B21"],
  // Diagonal upper (−46.5°): B22–B33
  ["B22","B23","B24","B25","B26","B27","B28","B29","B30","B31","B32","B33"],
  // Diagonal lower (−48.5°): B34–B48
  ["B34","B35","B36","B37","B38","B39","B40","B41","B42","B43","B44","B45","B46","B47","B48"],
];

// ---------------------------------------------------------------------------
// Default labels — matches the physical paint markings on the lot today
// ---------------------------------------------------------------------------
export const DEFAULT_LABELS: Record<string, string> = {
  "B1": "B42", "B2": "B41", "B3": "B40", "B4": "B39", "B5": "B38",
  "B6": "B37", "B7": "B36", "B8": "B35", "B9": "B34", "B10": "B33",
  "B11": "--",
  "B12": "B45", "B13": "B44", "B14": "B43",
  "B22": "B32", "B23": "B31", "B24": "B30", "B25": "B29", "B26": "B28",
  "B27": "B27", "B28": "B26", "B29": "B25", "B30": "B24", "B31": "B23",
  "B32": "B22", "B33": "B21",
  "B34": "B20", "B35": "B19", "B36": "B18", "B37": "B17", "B38": "B16",
  "B39": "B15", "B40": "B14", "B41": "B13", "B42": "B12", "B43": "B11",
  "B44": "B10", "B45": "B9", "B46": "B8", "B47": "B7", "B48": "B6",
  "B17": "B5", "B18": "B4", "B19": "B3", "B20": "B2", "B21": "B1",
  "T85": "74", "T84": "75", "T83": "76", "T82": "77", "T81": "78",
  "T74": "85", "T75": "84", "T76": "83", "T77": "82", "T78": "81",
  "T79": "80", "T80": "79",
};

/** Find the group a spot belongs to, and its index within that group */
function findGroup(spotId: string): { group: string[]; index: number } | null {
  for (const group of SPOT_GROUPS) {
    const idx = group.indexOf(spotId);
    if (idx !== -1) return { group, index: idx };
  }
  return null;
}

/**
 * Parse a label into prefix + number. Returns null if not numeric.
 * "B7" → { prefix: "B", num: 7 }
 * "42" → { prefix: "", num: 42 }
 * "hello" → null
 */
function parseLabel(label: string): { prefix: string; num: number } | null {
  const match = label.match(/^([A-Za-z]*)(\d+)$/);
  if (!match) return null;
  return { prefix: match[1], num: parseInt(match[2], 10) };
}

/**
 * Given a label edit, compute suggested labels for remaining spots in the group.
 *
 * Detects direction by checking the previous spot in the group:
 * - If previous spot has an override, computes delta (e.g. 30→29 = -1)
 * - Otherwise assumes +1 (ascending)
 *
 * Handles ascending (7→8→9), descending (30→29→28), and custom steps (2→4→6).
 * Works with prefixed labels (B7→B8→B9).
 */
export function computeSuggestions(
  spotId: string,
  newLabel: string,
  currentOverrides: Record<string, string>,
): { spotId: string; label: string }[] {
  const info = findGroup(spotId);
  if (!info) return [];

  const { group, index } = info;

  const parsed = parseLabel(newLabel);
  if (!parsed) return []; // Non-numeric label, can't auto-sequence

  const { prefix, num } = parsed;

  // Detect step by looking at the nearest edited neighbor (before or after)
  let step = 1; // default: ascending by 1

  // Check the spot before this one in the group
  if (index > 0) {
    const prevId = group[index - 1];
    const prevLabel = currentOverrides[prevId];
    if (prevLabel) {
      const prevParsed = parseLabel(prevLabel);
      if (prevParsed && prevParsed.prefix === prefix) {
        step = num - prevParsed.num; // e.g. 29-30=-1, 8-7=+1
        if (step === 0) step = 1;
      }
    }
  }

  // If no previous neighbor, check the spot after
  if (step === 1 && index < group.length - 1) {
    const nextId = group[index + 1];
    const nextLabel = currentOverrides[nextId];
    if (nextLabel) {
      const nextParsed = parseLabel(nextLabel);
      if (nextParsed && nextParsed.prefix === prefix) {
        step = nextParsed.num - num; // infer step from next spot
        if (step === 0) step = 1;
      }
    }
  }

  // Suggest for ALL other spots in the group (bidirectional)
  const suggestions: { spotId: string; label: string }[] = [];

  for (let i = 0; i < group.length; i++) {
    if (i === index) continue; // skip the spot we just edited
    const id = group[i];
    // Skip spots that already have a manually set override
    if (currentOverrides[id]) continue;
    // Only suggest for spots of the same type (T=truck, B=bobtail)
    if (id[0] !== spotId[0]) continue;

    const offset = i - index; // negative for spots before, positive for after
    const suggestedNum = num + step * offset;
    if (suggestedNum < 0) continue; // don't suggest negative numbers

    suggestions.push({
      spotId: id,
      label: `${prefix}${suggestedNum}`,
    });
  }

  return suggestions;
}

// Border path from DXF (SVG coordinates, Y flipped)
// Pushed outward ~15 units on tight edges to avoid spot corners nicking the fence
export const BORDER_LINES = [
  { x1: -5, y1: 1210, x2: 1005, y2: 1210 },        // bottom (pushed down)
  { x1: 1005, y1: 1210, x2: 1005, y2: 638 },       // right (pushed right)
  { x1: 1005, y1: 638, x2: 780, y2: 522 },          // upper-right angle (pushed out)
  { x1: 780, y1: 522, x2: 640, y2: 522 },           // horizontal step (pushed up)
  { x1: 640, y1: 522, x2: 390, y2: 302 },           // diagonal (pushed out)
  { x1: 390, y1: 302, x2: 390, y2: 218 },           // short vertical (pushed left)
  // spline connects to top-left
  { x1: -5, y1: -5, x2: 195, y2: 92 },              // top-left (pushed up-left)
  { x1: -5, y1: 1210, x2: -5, y2: -5 },             // left (pushed left)
];

// Cubic bezier approximation of the spline
export const BORDER_SPLINE = "M 390,218 C 362,255 298,195 195,92";

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

function spotFill(
  type: SpotLayout["type"],
  status: SpotStatus,
  isSelected: boolean,
  isHovered: boolean,
): string {
  if (isSelected) return "#EEF0FF";
  if (status === "OCCUPIED") return "#EEF0FF";
  if (isHovered) return type === "BOBTAIL" ? "#D6EAFF" : "#D6F5D9";
  return type === "BOBTAIL" ? "#E3F2FD" : "#E8F5E9";
}

function spotStroke(
  type: SpotLayout["type"],
  status: SpotStatus,
  isSelected: boolean,
): string {
  if (isSelected) return "#6366F1";
  if (status === "OCCUPIED") return "#6366F1";
  return type === "BOBTAIL" ? "#90CAF9" : "#A5D6A7";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function LotMap({ spots, onSpotClick, selectedSpotId, labelOverrides, onLabelChange, suggestions }: LotMapProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editorScreenPos, setEditorScreenPos] = useState<{ x: number; y: number } | null>(null);
  const svgRef = React.useRef<SVGSVGElement>(null);

  const suggestMap = useMemo(() => {
    const map = new Map<string, string>();
    suggestions?.forEach((s) => map.set(s.spotId, s.label));
    return map;
  }, [suggestions]);

  const spotDataMap = useMemo(() => {
    const map = new Map<string, SpotData>();
    spots.forEach((s) => map.set(s.id, s));
    return map;
  }, [spots]);

  const getLabel = useCallback(
    (layout: SpotLayout): string => labelOverrides?.[layout.id] ?? DEFAULT_LABELS[layout.id] ?? layout.label,
    [labelOverrides],
  );

  const getSpotData = useCallback(
    (layout: SpotLayout): SpotData =>
      spotDataMap.get(layout.id) ?? {
        id: layout.id,
        label: getLabel(layout),
        type: layout.type,
        status: "AVAILABLE" as SpotStatus,
      },
    [spotDataMap, getLabel],
  );

  const handleClick = useCallback(
    (layout: SpotLayout) => onSpotClick?.(getSpotData(layout)),
    [onSpotClick, getSpotData],
  );

  const handleDoubleClick = useCallback(
    (layout: SpotLayout) => {
      if (!onLabelChange) return;
      setEditingId(layout.id);
      setEditValue(getLabel(layout));
    },
    [onLabelChange, getLabel],
  );

  const commitEdit = useCallback(() => {
    if (editingId && onLabelChange && editValue.trim()) {
      onLabelChange(editingId, editValue.trim());
    }
    setEditingId(null);
    setEditValue("");
  }, [editingId, editValue, onLabelChange]);

  const hoveredLayout = hoveredId ? CAD_SPOTS.find((s) => s.id === hoveredId) : null;
  const hoveredData = hoveredLayout ? getSpotData(hoveredLayout) : null;
  const editingLayout = editingId ? CAD_SPOTS.find((s) => s.id === editingId) : null;

  // Compute screen coordinates for the floating label editor outside of render
  useEffect(() => {
    Promise.resolve().then(() => {
      if (!editingLayout || !svgRef.current) {
        setEditorScreenPos(null);
        return;
      }
      const svg = svgRef.current;
      const pt = svg.createSVGPoint();
      pt.x = editingLayout.cx;
      pt.y = editingLayout.cy;
      const ctm = svg.getScreenCTM();
      if (!ctm) {
        setEditorScreenPos(null);
        return;
      }
      const screenPt = pt.matrixTransform(ctm);
      setEditorScreenPos({ x: screenPt.x, y: screenPt.y });
    });
  }, [editingId, editingLayout]);

  return (
    <div style={{ width: "100%", fontFamily: "var(--font-body, 'DM Sans', sans-serif)" }}>
      <svg
        ref={svgRef}
        viewBox="-20 -20 1050 1250"
        width="100%"
        style={{
          display: "block",
          backgroundColor: "#FAFAF8",
          borderRadius: 12,
          border: "1px solid var(--border, #E0DDD6)",
        }}
      >
        {/* Background grid */}
        <defs>
          <pattern id="lotGrid" width="50" height="50" patternUnits="userSpaceOnUse">
            <path d="M 50 0 L 0 0 0 50" fill="none" stroke="#E8E6E0" strokeWidth="0.4" />
          </pattern>
        </defs>
        <rect width="1000" height="1211" fill="url(#lotGrid)" />

        {/* ── Property border ── */}
        {BORDER_LINES.map((l, i) => (
          <line
            key={`border-${i}`}
            x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
            stroke="#1A1A1A"
            strokeWidth="2"
            opacity={0.3}
          />
        ))}
        <path d={BORDER_SPLINE} fill="none" stroke="#1A1A1A" strokeWidth="2" opacity={0.3} />

        {/* ── Section labels ── */}
        <text x="30" y="960" fontSize="12" fill="#6B6B6B" fontFamily="var(--font-display)" fontWeight="700" letterSpacing="2">
          18-WHEELER
        </text>
        <text x="30" y="310" fontSize="10" fill="#6B6B6B" fontFamily="var(--font-display)" fontWeight="700" letterSpacing="2">
          BOBTAIL
        </text>
        <text x="830" y="640" fontSize="12" fill="#6B6B6B" fontFamily="var(--font-display)" fontWeight="700" letterSpacing="2">
          18-WHEELER
        </text>
        <text x="310" y="340" fontSize="10" fill="#6B6B6B" fontFamily="var(--font-display)" fontWeight="700" letterSpacing="1.5" transform="rotate(-47, 310, 340)">
          BOBTAIL ONLY
        </text>

        {/* ── Parking spots ── */}
        {CAD_SPOTS.map((layout) => {
          const data = getSpotData(layout);
          const isSelected = selectedSpotId === layout.id;
          const isHovered = hoveredId === layout.id;
          const suggestedLabel = suggestMap.get(layout.id);
          const isSuggested = !!suggestedLabel;

          const fill = isSuggested
            ? "#E8EAF6" // light indigo for suggested
            : editingId === layout.id
              ? "#FFF8E1"
              : spotFill(layout.type, data.status, isSelected, isHovered);
          const stroke = isSuggested
            ? "#7986CB" // indigo border for suggested
            : editingId === layout.id
              ? "#FFA000"
              : spotStroke(layout.type, data.status, isSelected);
          const sw = isSuggested ? 2 : editingId === layout.id ? 2.5 : isSelected ? 3 : 1;

          const transform = layout.rot !== 0
            ? `rotate(${layout.rot}, ${layout.cx}, ${layout.cy})`
            : undefined;

          const fontSize = Math.max(5, Math.min(8, Math.min(layout.w, layout.h) * 0.4));
          const displayLabel = isSuggested ? suggestedLabel : getLabel(layout);

          return (
            <g
              key={layout.id}
              transform={transform}
              style={{ cursor: onLabelChange ? "text" : "pointer" }}
              onMouseEnter={() => setHoveredId(layout.id)}
              onMouseLeave={() => setHoveredId(null)}
              onClick={() => handleClick(layout)}
              onDoubleClick={(e) => { e.stopPropagation(); handleDoubleClick(layout); }}
            >
              <rect
                x={layout.cx - layout.w / 2}
                y={layout.cy - layout.h / 2}
                width={layout.w}
                height={layout.h}
                rx={2}
                fill={fill}
                stroke={stroke}
                strokeWidth={sw}
                style={{ transition: "fill 0.15s, stroke 0.15s" }}
              />
              <text
                x={layout.cx}
                y={layout.cy + fontSize * 0.35}
                fontSize={fontSize}
                fill={isSuggested ? "#3F51B5" : data.status === "OCCUPIED" ? "#6366F1" : "#1A1A1A"}
                textAnchor="middle"
                fontFamily="var(--font-display)"
                fontWeight="600"
                pointerEvents="none"
                opacity={isSuggested ? 0.9 : 0.8}
              >
                {displayLabel}
              </text>
              {data.status === "OCCUPIED" && (
                <circle
                  cx={layout.cx + layout.w / 2 - 4}
                  cy={layout.cy - layout.h / 2 + 4}
                  r={2.5}
                  fill="#6366F1"
                />
              )}
            </g>
          );
        })}

        {/* ── Tooltip ── */}
        {hoveredLayout && hoveredData && (() => {
          const ttW = 160;
          const ttH = hoveredData.status === "OCCUPIED" ? (hoveredData.driverName ? 72 : 56) : 42;
          const tx = Math.max(4, Math.min(1000 - ttW - 4, hoveredLayout.cx - ttW / 2));
          let ty = hoveredLayout.cy - hoveredLayout.h / 2 - ttH - 8;
          if (ty < 4) ty = hoveredLayout.cy + hoveredLayout.h / 2 + 8;

          return (
            <g pointerEvents="none">
              <rect x={tx} y={ty} width={ttW} height={ttH} rx={6} fill="#FFF" stroke="#E0DDD6" strokeWidth="1" filter="drop-shadow(0 2px 6px rgba(0,0,0,0.1))" />
              <text x={tx + 10} y={ty + 16} fontSize="11" fill="#1A1A1A" fontFamily="var(--font-display)" fontWeight="700">
                Spot {hoveredData.label}
              </text>
              <text x={tx + 10} y={ty + 30} fontSize="9" fill={hoveredData.status === "OCCUPIED" ? "#6366F1" : "#2D7A3A"} fontFamily="var(--font-body)" fontWeight="600">
                {hoveredData.status === "OCCUPIED" ? "Occupied" : "Available"} — {hoveredData.type === "BOBTAIL" ? "Bobtail" : "Truck"}
              </text>
              {hoveredData.status === "OCCUPIED" && hoveredData.vehicle && (
                <text x={tx + 10} y={ty + 44} fontSize="8" fill="#6B6B6B" fontFamily="var(--font-body)">
                  {[hoveredData.vehicle.unitNumber && `#${hoveredData.vehicle.unitNumber}`, hoveredData.vehicle.licensePlate].filter(Boolean).join(" | ")}
                </text>
              )}
              {hoveredData.status === "OCCUPIED" && hoveredData.driverName && (
                <text x={tx + 10} y={ty + (hoveredData.vehicle ? 58 : 44)} fontSize="8" fill="#6B6B6B" fontFamily="var(--font-body)">
                  {hoveredData.driverName}
                </text>
              )}
            </g>
          );
        })()}

        {/* ── Legend ── */}
        <g transform="translate(30, 1190)">
          <rect x="0" y="0" width="940" height="32" rx="6" fill="#FFF" stroke="#E0DDD6" strokeWidth="0.8" opacity={0.9} />
          <rect x="16" y="8" width="14" height="14" rx="2" fill="#E8F5E9" stroke="#A5D6A7" strokeWidth="1" />
          <text x="36" y="19" fontSize="8" fill="#1A1A1A" fontFamily="var(--font-body)">Truck</text>
          <rect x="100" y="8" width="14" height="14" rx="2" fill="#EEF0FF" stroke="#6366F1" strokeWidth="1" />
          <text x="120" y="19" fontSize="8" fill="#1A1A1A" fontFamily="var(--font-body)">Occupied</text>
          <rect x="210" y="8" width="14" height="14" rx="2" fill="#E3F2FD" stroke="#90CAF9" strokeWidth="1" />
          <text x="230" y="19" fontSize="8" fill="#1A1A1A" fontFamily="var(--font-body)">Bobtail</text>
          <rect x="310" y="8" width="14" height="14" rx="2" fill="#EEF0FF" stroke="#6366F1" strokeWidth="3" />
          <text x="330" y="19" fontSize="8" fill="#1A1A1A" fontFamily="var(--font-body)">Selected</text>
          <text x="450" y="19" fontSize="8" fill="#9A9A9A" fontFamily="var(--font-body)">
            85 Truck + 48 Bobtail = 133 Total
          </text>
        </g>
      </svg>

      {/* ── Floating label editor (HTML overlay) ── */}
      {editingLayout && editorScreenPos && (
        <input
          autoFocus
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitEdit();
            if (e.key === "Escape") { setEditingId(null); setEditValue(""); }
          }}
          onBlur={commitEdit}
          style={{
            position: "fixed",
            left: editorScreenPos.x - 40,
            top: editorScreenPos.y - 14,
            width: 80,
            height: 28,
            fontSize: 14,
            fontFamily: "var(--font-display, 'Barlow Condensed', sans-serif)",
            fontWeight: 700,
            textAlign: "center",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            border: "2px solid #FFA000",
            borderRadius: 6,
            background: "#FFF8E1",
            color: "#1A1A1A",
            outline: "none",
            boxShadow: "0 2px 12px rgba(0,0,0,0.15)",
            zIndex: 9999,
          }}
        />
      )}
    </div>
  );
}
