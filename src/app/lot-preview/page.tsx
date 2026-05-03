"use client";

import { useState } from "react";
import LotMap from "@/components/lot/LotMap";
import { computeSuggestions, DEFAULT_LABELS } from "@/components/lot/LotMap";
import type { LabelSuggestion } from "@/components/lot/LotMap";

const LABELS_KEY = "lot-map-labels";

function loadLabels(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(LABELS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveLabels(labels: Record<string, string>) {
  localStorage.setItem(LABELS_KEY, JSON.stringify(labels));
}

export default function LotPreviewPage() {
  const [labels, setLabels] = useState<Record<string, string>>(loadLabels);
  const [selected, setSelected] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [suggestions, setSuggestions] = useState<LabelSuggestion[]>([]);

  function handleLabelChange(spotId: string, newLabel: string) {
    const next = { ...labels, [spotId]: newLabel };
    setLabels(next);
    saveLabels(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);

    // Compute suggestions for remaining spots in the group
    // Merge defaults so suggestions skip spots that already have default labels
    const suggs = computeSuggestions(spotId, newLabel, { ...DEFAULT_LABELS, ...next });
    setSuggestions(suggs);
  }

  function acceptSuggestions() {
    const next = { ...labels };
    suggestions.forEach((s) => {
      next[s.spotId] = s.label;
    });
    setLabels(next);
    saveLabels(next);
    setSuggestions([]);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  function dismissSuggestions() {
    setSuggestions([]);
  }

  function handleReset() {
    if (confirm("Reset all labels to defaults?")) {
      localStorage.removeItem(LABELS_KEY);
      setLabels({});
      setSuggestions([]);
    }
  }

  function handleExport() {
    const json = JSON.stringify(labels, null, 2);
    navigator.clipboard.writeText(json);
    alert("Labels JSON copied to clipboard!");
  }

  const editCount = Object.keys(labels).length;

  return (
    <div
      className="h-screen flex flex-col p-4 overflow-hidden"
      style={{ background: "var(--bg)" }}
    >
      {/* Header */}
      <div className="flex items-center gap-4 mb-2 shrink-0 flex-wrap">
        <h1
          className="text-2xl font-extrabold tracking-wider uppercase"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Lot Map
        </h1>
        <p className="text-xs" style={{ color: "var(--fg-muted)" }}>
          Double-click to edit label. Sequences auto-suggest.
        </p>

        {saved && (
          <span
            className="text-xs font-semibold px-2 py-1 rounded-md"
            style={{ background: "#D1FAE5", color: "#2D7A3A" }}
          >
            Saved
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {editCount > 0 && (
            <span className="text-xs" style={{ color: "var(--fg-subtle)" }}>
              {editCount} label{editCount !== 1 ? "s" : ""} set
            </span>
          )}
          {editCount > 0 && (
            <button
              onClick={handleExport}
              className="text-xs font-semibold px-3 py-1.5 rounded-md border"
              style={{
                borderColor: "var(--border)",
                color: "var(--fg-muted)",
                background: "var(--bg-card)",
              }}
            >
              Copy JSON
            </button>
          )}
          {editCount > 0 && (
            <button
              onClick={handleReset}
              className="text-xs font-semibold px-3 py-1.5 rounded-md border"
              style={{
                borderColor: "#FECACA",
                color: "var(--error)",
                background: "#FEF2F2",
              }}
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {/* Suggestion banner */}
      {suggestions.length > 0 && (
        <div
          className="flex items-center gap-3 px-4 py-2.5 rounded-lg mb-2 shrink-0"
          style={{ background: "#E8EAF6", border: "1px solid #7986CB" }}
        >
          <span className="text-sm font-medium" style={{ color: "#3F51B5" }}>
            Auto-fill {suggestions.length} spot{suggestions.length !== 1 ? "s" : ""}?
          </span>
          <span className="text-xs" style={{ color: "#5C6BC0" }}>
            {suggestions[0].label} → {suggestions[suggestions.length - 1].label}
          </span>
          <div className="ml-auto flex gap-2">
            <button
              onClick={acceptSuggestions}
              className="text-xs font-bold px-4 py-1.5 rounded-md text-white"
              style={{ background: "#3F51B5" }}
            >
              Accept
            </button>
            <button
              onClick={dismissSuggestions}
              className="text-xs font-semibold px-3 py-1.5 rounded-md"
              style={{ color: "#5C6BC0", background: "#C5CAE9" }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Map */}
      <div className="flex-1 min-h-0 flex items-start justify-center">
        <div
          className="rounded-xl border overflow-hidden h-full"
          style={{
            background: "var(--bg-card)",
            borderColor: "var(--border)",
            aspectRatio: "1050 / 1250",
            maxHeight: "100%",
          }}
        >
          <LotMap
            spots={[]}
            selectedSpotId={selected}
            onSpotClick={(spot) => setSelected(spot.id === selected ? null : spot.id)}
            labelOverrides={labels}
            onLabelChange={handleLabelChange}
            suggestions={suggestions}
          />
        </div>
      </div>
    </div>
  );
}
