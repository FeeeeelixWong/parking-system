"use client";

import React, { Suspense, useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import LotMapEditor from "@/components/lot/LotMapEditor";
import LotMapViewer, { countStatuses } from "@/components/lot/LotMapViewer";
import EditorSidebar from "@/components/lot/editor/EditorSidebar";
import { useEditorReducer } from "@/components/lot/editor/useEditorReducer";
import SpotDetailPanel from "./SpotDetailPanel";
import { computePath, pathD, pathTotalLength, ENTRANCE } from "./pathfinding";
import { apiFetch } from "@/lib/fetch";
import { deriveLotStatus } from "@/lib/lot-status";

import type {
  ApiSpotWithSessions as ApiSpot,
  SpotLayout,
  LotSpotStatus,
  LotSpotDetail,
} from "@/types/domain";

const ASSIGNED_COLORS = {
  fill: "#061830",
  fillHover: "#0A2040",
  stroke: "#0A84FF",
  label: "#60AAFF",
};

// ---------------------------------------------------------------------------
// Transition duration
// ---------------------------------------------------------------------------
const T = "0.45s cubic-bezier(0.4, 0, 0.2, 1)";

// ---------------------------------------------------------------------------
// Wrapper with Suspense (required for useSearchParams in App Router)
// ---------------------------------------------------------------------------
export default function LotPageWrapper() {
  return (
    <Suspense
      fallback={
        <div style={{ height: "100vh", background: "#1C1C1E", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ color: "#636366", fontSize: 13 }}>Loading lot...</span>
        </div>
      }
    >
      <LotPage />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
function LotPage() {
  const searchParams = useSearchParams();
  const demoSpotId   = searchParams.get("spotId") ?? null;
  const demoName     = searchParams.get("name") ?? "";
  const demoVehicle  = searchParams.get("vehicle") ?? "";
  const demoHours    = searchParams.get("hours") ?? "";
  const isDemo       = searchParams.get("demo") === "1" && !!demoSpotId;

  const [mode, setMode] = useState<"view" | "edit">("view");
  const isEdit = mode === "edit";

  // Editor state
  const editor = useEditorReducer();

  // Derive spots from editor state (reflects saved changes)
  const allSpots = useMemo<SpotLayout[]>(
    () => Object.values(editor.state.spots),
    [editor.state.spots],
  );

  // Live data from API
  const [apiSpots, setApiSpots] = useState<ApiSpot[]>([]);

  useEffect(() => {
    const load = () =>
      apiFetch<{ spots: ApiSpot[] }>("/api/spots")
        .then((d) => setApiSpots(d.spots ?? []))
        .catch(() => {});
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, []);

  // Build statuses from live API data — keyed by label (bridges DB spots ↔ editor spots)
  const statuses = useMemo<Record<string, LotSpotStatus>>(() => {
    const map: Record<string, LotSpotStatus> = {};
    for (const spot of apiSpots) {
      map[spot.label] = deriveLotStatus(spot.sessions?.[0]);
    }
    return map;
  }, [apiSpots]);

  // Build detail panels from live API data — keyed by label
  const spotDetails = useMemo<Record<string, LotSpotDetail>>(() => {
    const map: Record<string, LotSpotDetail> = {};
    for (const spot of apiSpots) {
      const session = spot.sessions?.[0] ?? null;
      const status = statuses[spot.label] ?? "VACANT";
      map[spot.label] = {
        spotId: spot.id,
        spotLabel: spot.label,
        status,
        session: session
          ? {
              id: session.id,
              driver: session.driver,
              vehicle: session.vehicle,
              startedAt: new Date(session.startedAt),
              expectedEnd: new Date(session.expectedEnd),
              endedAt: session.endedAt ? new Date(session.endedAt) : null,
              sessionStatus: session.status,
              reminderSent: session.reminderSent,
              payments: [],
            }
          : null,
      };
    }
    return map;
  }, [apiSpots, statuses]);

  // Status view state
  const [selectedSpotId, setSelectedSpotId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // ---------------------------------------------------------------------------
  // Pathfinding (demo mode only)
  // ---------------------------------------------------------------------------
  const demoPath = useMemo(
    () => (isDemo && demoSpotId ? computePath(allSpots, demoSpotId) : null),
    [isDemo, demoSpotId, allSpots],
  );
  const demoPathD      = useMemo(() => (demoPath ? pathD(demoPath) : ""), [demoPath]);
  const demoPathLength = useMemo(() => (demoPath ? pathTotalLength(demoPath) : 0), [demoPath]);

  // Animate path drawing: dashoffset starts hidden (large value) → 0
  const [dashOffset, setDashOffset] = useState(99999);
  const animRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!demoPathLength) return;
    const initTimer = setTimeout(() => setDashOffset(demoPathLength), 0);
    animRef.current = setTimeout(() => setDashOffset(0), 150);
    return () => { clearTimeout(initTimer); if (animRef.current) clearTimeout(animRef.current); };
  }, [demoPathLength]);

  // Pulse counter for the assigned spot rings
  const [pulseKey, setPulseKey] = useState(0);
  useEffect(() => {
    if (!isDemo) return;
    const id = setInterval(() => setPulseKey((k) => k + 1), 1800);
    return () => clearInterval(id);
  }, [isDemo]);

  const assignedSpot = useMemo(
    () => (demoSpotId ? allSpots.find((s) => s.id === demoSpotId) ?? null : null),
    [demoSpotId, allSpots],
  );

  // ---------------------------------------------------------------------------
  const handleSave = useCallback(async () => {
    await editor.saveSnapshot();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [editor]);

  const handleDiscard = useCallback(() => {
    if (confirm("Discard all unsaved changes?")) {
      editor.discardChanges();
    }
  }, [editor]);

  const handleToggleMode = useCallback(() => {
    if (isEdit && editor.hasUnsavedChanges) {
      const choice = confirm("You have unsaved changes. Save before leaving?");
      if (choice) editor.saveSnapshot();
    }
    setSelectedSpotId(null);
    setMode(isEdit ? "view" : "edit");
  }, [isEdit, editor]);

  const counts = useMemo(
    () => countStatuses(allSpots, statuses, demoSpotId),
    [allSpots, statuses, demoSpotId],
  );

  return (
    <div style={{
      height: "100vh",
      display: "flex",
      flexDirection: "column",
      background: "#1C1C1E",
      overflow: "hidden",
      fontFamily: "var(--font-body)",
    }}>
      {/* Demo assignment banner */}
      {isDemo && (
        <div style={{
          background: "linear-gradient(90deg, #0A2A50 0%, #0A1E38 100%)",
          borderBottom: "1px solid #0A84FF44",
          padding: "10px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
          zIndex: 20,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            {/* Pulsing dot */}
            <div style={{ position: "relative", width: 10, height: 10 }}>
              <div style={{
                position: "absolute",
                inset: 0,
                borderRadius: "50%",
                background: "#0A84FF",
              }} />
              <div className="demo-ping" style={{
                position: "absolute",
                inset: -4,
                borderRadius: "50%",
                border: "2px solid #0A84FF",
              }} />
            </div>
            <div>
              <span style={{ color: "#F5F5F7", fontWeight: 700, fontSize: 14, fontFamily: "var(--font-display)", letterSpacing: "0.03em" }}>
                Spot {assignedSpot?.label ?? demoSpotId} assigned
              </span>
              {demoName && (
                <span style={{ color: "#98989D", fontSize: 13, marginLeft: 10 }}>
                  {demoName}
                  {demoVehicle && <span style={{ marginLeft: 8, opacity: 0.7 }}>· {demoVehicle}</span>}
                  {demoHours && <span style={{ marginLeft: 8, opacity: 0.7 }}>· {demoHours} hrs</span>}
                </span>
              )}
            </div>
          </div>
          <span style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "#0A84FF",
            background: "#0A84FF18",
            border: "1px solid #0A84FF33",
            padding: "3px 10px",
            borderRadius: 20,
          }}>
            Demo
          </span>
        </div>
      )}

      {/* Header bar — collapses in edit mode */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: isEdit ? "0 20px" : "12px 20px",
        maxHeight: isEdit ? 0 : 60,
        borderBottom: isEdit ? "none" : "1px solid #2C2C2E",
        flexShrink: 0,
        zIndex: 10,
        overflow: "hidden",
        opacity: isEdit ? 0 : 1,
        transition: `max-height ${T}, padding ${T}, opacity ${T}`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <h1 style={{ fontSize: 16, fontWeight: 600, color: "#F5F5F7", margin: 0, letterSpacing: "-0.01em" }}>
            Parking Lot
          </h1>

          {/* Status counts */}
          <div style={{ display: "flex", gap: 16, fontSize: 12 }}>
            <span style={{ color: "#98989D" }}>
              <span style={{ color: "#2D7A4A", fontWeight: 600 }}>{counts.vacant}</span> vacant
            </span>
            <span style={{ color: "#98989D" }}>
              <span style={{ color: "#6366F1", fontWeight: 600 }}>{counts.reserved}</span> reserved
            </span>
            <span style={{ color: "#98989D" }}>
              <span style={{ color: "#DC2626", fontWeight: 600 }}>{counts.overdue}</span> overdue
            </span>
            <span style={{ color: "#636366" }}>|</span>
            <span style={{ color: "#98989D" }}>
              <span style={{ color: "#F5F5F7", fontWeight: 600 }}>{counts.total}</span> total
            </span>
          </div>
        </div>

        <button
          onClick={handleToggleMode}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 14px",
            background: "#2C2C2E",
            border: "1px solid #3A3A3C",
            borderRadius: 6,
            color: "#AEAEB2",
            fontSize: 12,
            fontWeight: 500,
            fontFamily: "var(--font-body)",
            cursor: "pointer",
          }}
        >
          Edit Layout
        </button>
      </div>

      {/* Main content area */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", position: "relative" }}>
        {/* Sidebar — slides in from left */}
        <div style={{
          width: isEdit ? 260 : 0,
          minWidth: isEdit ? 260 : 0,
          transition: `width ${T}, min-width ${T}`,
          overflow: "hidden",
          flexShrink: 0,
        }}>
          <EditorSidebar
            state={editor.state}
            dispatch={editor.dispatch}
            onReset={editor.resetToDefaults}
            onExport={editor.exportJSON}
            saved={saved}
          />
        </div>

        {/* Map area */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden", transition: `flex ${T}` }}>
          {/* Status view (read-only SVG) */}
          <div style={{
            position: "absolute",
            inset: 0,
            opacity: isEdit ? 0 : 1,
            pointerEvents: isEdit ? "none" : "auto",
            transition: `opacity ${T}`,
            zIndex: isEdit ? 0 : 1,
          }}>
            <LotMapViewer
              spots={allSpots}
              statuses={statuses}
              selectedSpotId={selectedSpotId}
              onSelectSpot={setSelectedSpotId}
            >
              {/* Demo-only: navigation arrow marker */}
              {isDemo && (
                <defs>
                  <marker id="navArrow" markerWidth="6" markerHeight="5" refX="5" refY="2.5" orient="auto">
                    <polygon points="0 0, 6 2.5, 0 5" fill="#0A84FF" opacity="0.9" />
                  </marker>
                </defs>
              )}

              {/* Demo-only: navigation path */}
              {isDemo && demoPathD && (
                <path
                  d={demoPathD}
                  fill="none"
                  stroke="#0A84FF"
                  strokeWidth="3.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={`${demoPathLength} ${demoPathLength}`}
                  strokeDashoffset={dashOffset}
                  markerEnd="url(#navArrow)"
                  opacity={0.85}
                  style={{ transition: "stroke-dashoffset 2.8s cubic-bezier(0.4, 0, 0.2, 1)" }}
                />
              )}

              {/* Demo-only: entrance marker */}
              {isDemo && (
                <g>
                  <circle cx={ENTRANCE[0]} cy={ENTRANCE[1]} r={8} fill="#0A84FF" opacity={0.9} />
                  <circle cx={ENTRANCE[0]} cy={ENTRANCE[1]} r={14} fill="none" stroke="#0A84FF" strokeWidth="1.5" opacity={0.4} />
                  <text
                    x={ENTRANCE[0]}
                    y={ENTRANCE[1] + 26}
                    textAnchor="middle"
                    fontSize={9}
                    fill="#0A84FF"
                    fontWeight="700"
                    letterSpacing="0.08em"
                    fontFamily="var(--font-body)"
                  >
                    ENTER
                  </text>
                </g>
              )}

              {/* Demo-only: assigned spot pulse rings */}
              {isDemo && assignedSpot && (() => {
                const spot = assignedSpot;
                const transform = spot.rot !== 0 ? `rotate(${spot.rot}, ${spot.cx}, ${spot.cy})` : undefined;
                const fontSize = Math.max(10, Math.min(16, Math.min(spot.w, spot.h) * 0.75));
                return (
                  <g transform={transform}>
                    <rect key={`ring1-${pulseKey}`} x={spot.cx - spot.w / 2} y={spot.cy - spot.h / 2} width={spot.w} height={spot.h} rx={2} fill="none" stroke="#0A84FF" strokeWidth="1.5" className="spot-ring" style={{ animationDelay: "0s" }} />
                    <rect key={`ring2-${pulseKey}`} x={spot.cx - spot.w / 2} y={spot.cy - spot.h / 2} width={spot.w} height={spot.h} rx={2} fill="none" stroke="#0A84FF" strokeWidth="1.5" className="spot-ring" style={{ animationDelay: "0.4s" }} />
                    <rect x={spot.cx - spot.w / 2} y={spot.cy - spot.h / 2} width={spot.w} height={spot.h} rx={1} fill={ASSIGNED_COLORS.fill} stroke={ASSIGNED_COLORS.stroke} strokeWidth={2} className="spot-assigned-blink" />
                    <text x={spot.cx} y={spot.cy + fontSize * 0.35} fontSize={fontSize} fill={ASSIGNED_COLORS.label} textAnchor="middle" fontFamily="var(--font-body)" fontWeight="700" pointerEvents="none">{spot.label}</text>
                  </g>
                );
              })()}
            </LotMapViewer>
          </div>

          {/* Editor view */}
          <div style={{
            position: "absolute",
            inset: 0,
            opacity: isEdit ? 1 : 0,
            pointerEvents: isEdit ? "auto" : "none",
            transition: `opacity ${T}`,
            zIndex: isEdit ? 1 : 0,
          }}>
            <LotMapEditor state={editor.state} dispatch={editor.dispatch} />
          </div>
        </div>

        {/* Spot detail panel */}
        <SpotDetailPanel
          detail={selectedSpotId ? spotDetails[allSpots.find(s => s.id === selectedSpotId)?.label ?? ""] ?? null : null}
          open={selectedSpotId !== null && !isEdit}
          onClose={() => setSelectedSpotId(null)}
        />

        {/* Floating back button — edit mode */}
        <button
          onClick={handleToggleMode}
          style={{
            position: "absolute",
            top: 12,
            right: 16,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 14px",
            background: "#2C2C2E",
            border: "1px solid #3A3A3C",
            borderRadius: 6,
            color: "#AEAEB2",
            fontSize: 12,
            fontWeight: 500,
            fontFamily: "var(--font-body)",
            cursor: "pointer",
            zIndex: 100,
            opacity: isEdit ? 1 : 0,
            pointerEvents: isEdit ? "auto" : "none",
            transition: `opacity ${T}`,
          }}
        >
          <span style={{ fontSize: 14 }}>&larr;</span> Back to Lot
        </button>

        {/* Floating save bar */}
        {isEdit && editor.hasUnsavedChanges && (
          <div style={{
            position: "absolute",
            bottom: 16,
            right: 16,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            background: "#2C2C2E",
            border: "1px solid #3A3A3C",
            borderRadius: 6,
            fontFamily: "var(--font-body)",
            zIndex: 100,
          }}>
            <span style={{ fontSize: 11, color: "#98989D", fontWeight: 500 }}>Unsaved changes</span>
            <button
              onClick={handleDiscard}
              style={{
                padding: "5px 12px", fontSize: 11, fontWeight: 500,
                border: "1px solid #3A3A3C", borderRadius: 4,
                background: "transparent", color: "#AEAEB2",
                cursor: "pointer", fontFamily: "var(--font-body)",
              }}
            >
              Discard
            </button>
            <button
              onClick={handleSave}
              style={{
                padding: "5px 14px", fontSize: 11, fontWeight: 600,
                border: "none", borderRadius: 4,
                background: "#0A84FF", color: "#fff",
                cursor: "pointer", fontFamily: "var(--font-body)",
              }}
            >
              Save
            </button>
          </div>
        )}
      </div>

      {/* Bottom bar — collapses in edit mode */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: isEdit ? "0 20px" : "10px 20px",
        maxHeight: isEdit ? 0 : 50,
        borderTop: isEdit ? "none" : "1px solid #2C2C2E",
        flexShrink: 0,
        overflow: "hidden",
        opacity: isEdit ? 0 : 1,
        transition: `max-height ${T}, padding ${T}, opacity ${T}`,
      }}>
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 20,
          fontSize: 11,
          color: "#98989D",
        }}>
          {isDemo ? (
            <span style={{ color: "#0A84FF", fontWeight: 600, fontSize: 11 }}>
              Follow the blue path to spot {assignedSpot?.label ?? demoSpotId}
            </span>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 12, height: 12, borderRadius: 2, background: "#12261C", border: "1px solid #2D7A4A" }} />
                <span>Vacant</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 12, height: 12, borderRadius: 2, background: "#1A1A2E", border: "1px solid #6366F1" }} />
                <span>Reserved</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 12, height: 12, borderRadius: 2, background: "#1C1A10", border: "1px solid #CA8A04" }} />
                <span>Company</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 12, height: 12, borderRadius: 2, background: "#2C1810", border: "1px solid #DC2626" }} />
                <span>Overdue</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
