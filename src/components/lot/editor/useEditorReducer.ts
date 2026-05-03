// ---------------------------------------------------------------------------
// Lot Editor — Reducer + state management
// ---------------------------------------------------------------------------

import { useReducer, useCallback, useState, useMemo, useEffect } from "react";
import type { EditorSpot, SpotGroup, EditorState, EditorAction } from "./types";
import { computeNewSpotPosition, getGroupTemplate, snapToGrid } from "./geometry";
import { findOverlaps, wouldOverlap } from "./validation";
import defaultData from "./defaultState.json";

// ---------------------------------------------------------------------------
// Build EditorState from a data snapshot (spots + groups + counters)
// ---------------------------------------------------------------------------
type DataSnapshot = {
  spots: Record<string, EditorSpot>;
  groups: SpotGroup[];
  nextTruckNum: number;
  nextBobtailNum: number;
  nextGroupNum: number;
};

function stateFromData(data: DataSnapshot): EditorState {
  return {
    spots: data.spots,
    groups: data.groups,
    selectedGroupIds: [],
    selectedSpotId: null,
    tool: "select",
    overlaps: findOverlaps(data.spots),
    errorFlash: null,
    nextTruckNum: data.nextTruckNum,
    nextBobtailNum: data.nextBobtailNum,
    nextGroupNum: data.nextGroupNum,
    undoStack: [],
  };
}

// ---------------------------------------------------------------------------
// Initialize: try localStorage first, fall back to baked-in default
// ---------------------------------------------------------------------------
const STORAGE_KEY = "lot-editor-state";

function getDefaultData(): DataSnapshot {
  return {
    spots: defaultData.spots as Record<string, EditorSpot>,
    groups: defaultData.groups as SpotGroup[],
    nextTruckNum: defaultData.nextTruckNum,
    nextBobtailNum: defaultData.nextBobtailNum,
    nextGroupNum: defaultData.nextGroupNum,
  };
}

function initState(): EditorState {
  // Try to load from localStorage synchronously — no flash
  if (typeof window !== "undefined") {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.spots && parsed.groups) {
          return stateFromData({
            spots: parsed.spots,
            groups: parsed.groups,
            nextTruckNum: parsed.nextTruckNum ?? 86,
            nextBobtailNum: parsed.nextBobtailNum ?? 49,
            nextGroupNum: parsed.nextGroupNum ?? 12,
          });
        }
      }
    } catch {
      // fall through to default
    }
  }
  return stateFromData(getDefaultData());
}

// ---------------------------------------------------------------------------
// Undo snapshot (strips transient state)
// ---------------------------------------------------------------------------
function snapshot(state: EditorState) {
  return {
    spots: { ...state.spots },
    groups: state.groups.map((g) => ({ ...g, spotIds: [...g.spotIds] })),
    nextTruckNum: state.nextTruckNum,
    nextBobtailNum: state.nextBobtailNum,
    nextGroupNum: state.nextGroupNum,
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------
function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "SELECT_GROUP": {
      if (action.additive) {
        const already = state.selectedGroupIds.includes(action.groupId);
        const next = already
          ? state.selectedGroupIds.filter((id) => id !== action.groupId)
          : [...state.selectedGroupIds, action.groupId];
        return { ...state, selectedGroupIds: next, selectedSpotId: null };
      }
      return { ...state, selectedGroupIds: [action.groupId], selectedSpotId: null };
    }

    case "SELECT_GROUPS": {
      return { ...state, selectedGroupIds: action.groupIds, selectedSpotId: null };
    }

    case "SELECT_SPOT": {
      return { ...state, selectedSpotId: action.spotId };
    }

    case "DESELECT_ALL": {
      return { ...state, selectedGroupIds: [], selectedSpotId: null };
    }

    case "SET_TOOL": {
      return { ...state, tool: action.tool };
    }

    case "MOVE_GROUPS": {
      const dx = snapToGrid(action.dx);
      const dy = snapToGrid(action.dy);
      if (dx === 0 && dy === 0) return state;

      const groups = action.groupIds
        .map((id) => state.groups.find((g) => g.id === id))
        .filter(Boolean);
      if (groups.length === 0) return state;

      const movedIds: string[] = [];
      const proposed: Record<string, typeof state.spots[string]> = {};
      for (const group of groups) {
        for (const sid of group!.spotIds) {
          const s = state.spots[sid];
          if (!s) continue;
          movedIds.push(sid);
          proposed[sid] = { ...s, cx: s.cx + dx, cy: s.cy + dy };
        }
      }

      if (wouldOverlap(movedIds, proposed, state.spots)) {
        return { ...state, errorFlash: "Can't move — would overlap" };
      }

      const undo = snapshot(state);
      const newSpots = { ...state.spots, ...proposed };

      return {
        ...state,
        spots: newSpots,
        overlaps: findOverlaps(newSpots),
        undoStack: [...state.undoStack, undo],
        errorFlash: null,
      };
    }

    case "ADD_SPOT": {
      const group = state.groups.find((g) => g.id === action.groupId);
      if (!group) return state;

      const template = getGroupTemplate(group, state.spots);
      const pos = computeNewSpotPosition(group, state.spots, action.position);

      const isTruck = group.type === "TRUCK_TRAILER";
      const num = isTruck ? state.nextTruckNum : state.nextBobtailNum;
      const id = isTruck ? `T${num}` : `B${num}`;
      const label = isTruck ? `${num}` : `B${num}`;

      const newSpot: EditorSpot = {
        id,
        label,
        type: group.type,
        cx: pos.cx,
        cy: pos.cy,
        w: template.w,
        h: template.h,
        rot: template.rot,
      };

      if (wouldOverlap([id], { [id]: newSpot }, state.spots)) {
        return { ...state, errorFlash: "Can't add — would overlap" };
      }

      const undo = snapshot(state);
      const newSpots = { ...state.spots, [id]: newSpot };
      const newGroups = state.groups.map((g) => {
        if (g.id !== action.groupId) return g;
        const newIds =
          action.position === "start"
            ? [id, ...g.spotIds]
            : [...g.spotIds, id];
        return { ...g, spotIds: newIds };
      });

      return {
        ...state,
        spots: newSpots,
        groups: newGroups,
        overlaps: findOverlaps(newSpots),
        nextTruckNum: isTruck ? num + 1 : state.nextTruckNum,
        nextBobtailNum: isTruck ? state.nextBobtailNum : num + 1,
        undoStack: [...state.undoStack, undo],
      };
    }

    case "REMOVE_SPOT": {
      const undo = snapshot(state);
      const newSpots = { ...state.spots };
      delete newSpots[action.spotId];

      const newGroups = state.groups
        .map((g) => ({
          ...g,
          spotIds: g.spotIds.filter((id) => id !== action.spotId),
        }))
        .filter((g) => g.spotIds.length > 0);

      return {
        ...state,
        spots: newSpots,
        groups: newGroups,
        overlaps: findOverlaps(newSpots),
        selectedSpotId: state.selectedSpotId === action.spotId ? null : state.selectedSpotId,
        selectedGroupIds: state.selectedGroupIds.filter((id) =>
          newGroups.some((g) => g.id === id)
        ),
        undoStack: [...state.undoStack, undo],
      };
    }

    case "CREATE_GROUP": {
      const undo = snapshot(state);
      const isTruck = action.spotType === "TRUCK_TRAILER";
      const num = isTruck ? state.nextTruckNum : state.nextBobtailNum;
      const spotId = isTruck ? `T${num}` : `B${num}`;
      const label = isTruck ? `${num}` : `B${num}`;
      const groupId = `G${state.nextGroupNum}`;

      const newSpot: EditorSpot = {
        id: spotId,
        label,
        type: action.spotType,
        cx: snapToGrid(action.cx),
        cy: snapToGrid(action.cy),
        w: isTruck ? 149.1 : 74.5,
        h: 19.6,
        rot: action.angle,
      };

      const newGroup: SpotGroup = {
        id: groupId,
        name: `New Group ${state.nextGroupNum}`,
        type: action.spotType,
        spotIds: [spotId],
        spacing: isTruck ? 22.5 : 22.8,
        angle: action.angle,
      };

      const newSpots = { ...state.spots, [spotId]: newSpot };

      return {
        ...state,
        spots: newSpots,
        groups: [...state.groups, newGroup],
        selectedGroupIds: [groupId],
        selectedSpotId: null,
        tool: "select",
        overlaps: findOverlaps(newSpots),
        nextTruckNum: isTruck ? num + 1 : state.nextTruckNum,
        nextBobtailNum: isTruck ? state.nextBobtailNum : num + 1,
        nextGroupNum: state.nextGroupNum + 1,
        undoStack: [...state.undoStack, undo],
      };
    }

    case "DELETE_GROUP": {
      const group = state.groups.find((g) => g.id === action.groupId);
      if (!group) return state;

      const undo = snapshot(state);
      const newSpots = { ...state.spots };
      for (const sid of group.spotIds) {
        delete newSpots[sid];
      }

      return {
        ...state,
        spots: newSpots,
        groups: state.groups.filter((g) => g.id !== action.groupId),
        selectedGroupIds: state.selectedGroupIds.filter((id) => id !== action.groupId),
        selectedSpotId: null,
        overlaps: findOverlaps(newSpots),
        undoStack: [...state.undoStack, undo],
      };
    }

    case "RENAME_GROUP": {
      return {
        ...state,
        groups: state.groups.map((g) =>
          g.id === action.groupId ? { ...g, name: action.name } : g
        ),
      };
    }

    case "ROTATE_GROUP": {
      const group = state.groups.find((g) => g.id === action.groupId);
      if (!group) return state;

      const spotObjs = group.spotIds.map((id) => state.spots[id]).filter(Boolean);
      if (spotObjs.length === 0) return state;

      const gcx = spotObjs.reduce((s, sp) => s + sp.cx, 0) / spotObjs.length;
      const gcy = spotObjs.reduce((s, sp) => s + sp.cy, 0) / spotObjs.length;

      const oldAngle = (group.angle * Math.PI) / 180;
      const newAngle = (action.angle * Math.PI) / 180;
      const dAngle = newAngle - oldAngle;
      const cos = Math.cos(dAngle);
      const sin = Math.sin(dAngle);

      const proposed: Record<string, EditorSpot> = {};
      const movedIds: string[] = [];
      for (const sp of spotObjs) {
        const rx = sp.cx - gcx;
        const ry = sp.cy - gcy;
        movedIds.push(sp.id);
        proposed[sp.id] = {
          ...sp,
          cx: gcx + rx * cos - ry * sin,
          cy: gcy + rx * sin + ry * cos,
          rot: action.angle,
        };
      }

      if (wouldOverlap(movedIds, proposed, state.spots)) {
        return { ...state, errorFlash: "Can't rotate — would overlap" };
      }

      const undo = snapshot(state);
      const newSpots = { ...state.spots, ...proposed };
      const newGroups = state.groups.map((g) =>
        g.id === action.groupId ? { ...g, angle: action.angle } : g
      );

      return {
        ...state,
        spots: newSpots,
        groups: newGroups,
        overlaps: findOverlaps(newSpots),
        undoStack: [...state.undoStack, undo],
      };
    }

    case "CLEAR_ERROR": {
      return { ...state, errorFlash: null };
    }

    case "UNDO": {
      if (state.undoStack.length === 0) return state;
      const prev = state.undoStack[state.undoStack.length - 1];
      return {
        ...state,
        spots: prev.spots,
        groups: prev.groups,
        nextTruckNum: prev.nextTruckNum,
        nextBobtailNum: prev.nextBobtailNum,
        nextGroupNum: prev.nextGroupNum,
        overlaps: findOverlaps(prev.spots),
        undoStack: state.undoStack.slice(0, -1),
        selectedGroupIds: [],
        selectedSpotId: null,
      };
    }

    case "LOAD_STATE": {
      return {
        ...state,
        spots: action.state.spots,
        groups: action.state.groups,
        nextTruckNum: action.state.nextTruckNum,
        nextBobtailNum: action.state.nextBobtailNum,
        nextGroupNum: action.state.nextGroupNum,
        overlaps: findOverlaps(action.state.spots),
      };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export function useEditorReducer() {
  const [state, dispatch] = useReducer(editorReducer, undefined, initState);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Load layout from API on mount
  useEffect(() => {
    fetch("/api/spots/layout")
      .then((r) => r.json())
      .then((data) => {
        if (data.spots && Object.keys(data.spots).length > 0) {
          // Derive counters from existing spot IDs
          let maxT = 0, maxB = 0, maxG = 0;
          for (const id of Object.keys(data.spots)) {
            if (id.startsWith("T")) maxT = Math.max(maxT, parseInt(id.slice(1)) || 0);
            if (id.startsWith("B")) maxB = Math.max(maxB, parseInt(id.slice(1)) || 0);
          }
          const groups = Array.isArray(data.groups) ? data.groups : [];
          for (const g of groups) {
            if (typeof g.id === "string" && g.id.startsWith("G")) {
              maxG = Math.max(maxG, parseInt(g.id.slice(1)) || 0);
            }
          }
          dispatch({
            type: "LOAD_STATE",
            state: {
              spots: data.spots,
              groups,
              nextTruckNum: maxT + 1,
              nextBobtailNum: maxB + 1,
              nextGroupNum: maxG + 1,
            },
          });
        }
        // If API returns empty, keep the default state from initState
      })
      .catch(() => {
        // API failed — keep default state (first-time setup or offline)
      })
      .finally(() => setLoading(false));
  }, []);

  // Compute saved snapshot — updated after API load or save
  const [currentSavedSnapshot, setCurrentSavedSnapshot] = useState(() =>
    JSON.stringify({
      spots: state.spots,
      groups: state.groups,
      nextTruckNum: state.nextTruckNum,
      nextBobtailNum: state.nextBobtailNum,
      nextGroupNum: state.nextGroupNum,
    })
  );

  // Sync saved snapshot when state loads from API
  useEffect(() => {
    if (!loading) {
      setCurrentSavedSnapshot(JSON.stringify({
        spots: state.spots,
        groups: state.groups,
        nextTruckNum: state.nextTruckNum,
        nextBobtailNum: state.nextBobtailNum,
        nextGroupNum: state.nextGroupNum,
      }));
    }
    // Only run once after initial API load completes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // Detect unsaved changes
  const currentJSON = useMemo(() => JSON.stringify({
    spots: state.spots,
    groups: state.groups,
    nextTruckNum: state.nextTruckNum,
    nextBobtailNum: state.nextBobtailNum,
    nextGroupNum: state.nextGroupNum,
  }), [state.spots, state.groups, state.nextTruckNum, state.nextBobtailNum, state.nextGroupNum]);

  const hasUnsavedChanges = currentJSON !== currentSavedSnapshot;

  // Save to API (replaces localStorage.setItem)
  const saveSnapshot = useCallback(async () => {
    setSaving(true);
    try {
      const spotsArray = Object.values(state.spots);
      await fetch("/api/spots/layout", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spots: spotsArray, groups: state.groups }),
      });
      setCurrentSavedSnapshot(currentJSON);
    } catch {
      // Save failed — changes remain unsaved, user can retry
    } finally {
      setSaving(false);
    }
  }, [state.spots, state.groups, currentJSON]);

  const discardChanges = useCallback(() => {
    try {
      const parsed = JSON.parse(currentSavedSnapshot);
      dispatch({
        type: "LOAD_STATE",
        state: {
          spots: parsed.spots,
          groups: parsed.groups,
          nextTruckNum: parsed.nextTruckNum ?? 86,
          nextBobtailNum: parsed.nextBobtailNum ?? 49,
          nextGroupNum: parsed.nextGroupNum ?? 12,
        },
      });
    } catch {
      // Ignore
    }
  }, [currentSavedSnapshot]);

  const resetToDefaults = useCallback(async () => {
    const data = getDefaultData();
    dispatch({ type: "LOAD_STATE", state: data });
    // Save defaults to API
    setSaving(true);
    try {
      await fetch("/api/spots/layout", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spots: Object.values(data.spots), groups: data.groups }),
      });
      setCurrentSavedSnapshot(JSON.stringify(data));
    } catch {
      // Failed — local state reset but DB not synced
    } finally {
      setSaving(false);
    }
  }, []);

  const exportJSON = useCallback(() => {
    return JSON.stringify({ spots: Object.values(state.spots), groups: state.groups }, null, 2);
  }, [state.spots, state.groups]);

  return { state, dispatch, resetToDefaults, exportJSON, saveSnapshot, hasUnsavedChanges, discardChanges, loading, saving };
}
