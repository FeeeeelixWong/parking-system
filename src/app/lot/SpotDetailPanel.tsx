"use client";

import React from "react";
import type { LotSpotDetail, LotSpotStatus } from "@/types/domain";
import { LOT_STATUS_COLORS } from "@/types/domain";

const STATUS_LABELS: Record<LotSpotStatus, string> = {
  VACANT: "Vacant",
  RESERVED: "Reserved",
  OVERDUE: "Overdue",
};

function formatTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDateTime(d: Date): string {
  return `${formatDate(d)} ${formatTime(d)}`;
}

function timeAgo(d: Date): string {
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function timeUntil(d: Date): string {
  const diff = d.getTime() - Date.now();
  if (diff < 0) {
    const mins = Math.floor(-diff / 60_000);
    const hrs = Math.floor(mins / 60);
    return hrs > 0 ? `${hrs}h ${mins % 60}m overdue` : `${mins}m overdue`;
  }
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m remaining`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m remaining`;
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "5px 0" }}>
      <span style={{ color: "#636366", fontSize: 11, fontWeight: 500 }}>{label}</span>
      <span style={{ color: color ?? "#1C1C1E", fontSize: 12, fontWeight: 500, textAlign: "right", maxWidth: "60%" }}>
        {value}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        fontSize: 10,
        fontWeight: 600,
        color: "#8E8E93",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        marginBottom: 6,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

type Props = {
  detail: LotSpotDetail | null;
  onClose: () => void;
  open: boolean;
  mobile?: boolean;
};

export default function SpotDetailPanel({ detail, onClose, open, mobile }: Props) {
  const T = "0.35s cubic-bezier(0.4, 0, 0.2, 1)";
  const statusColor = detail ? LOT_STATUS_COLORS[detail.status].stroke : "#636366";

  // Mobile: slide up from bottom. Desktop: slide in from right.
  const panelStyle: React.CSSProperties = mobile
    ? {
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        maxHeight: "60vh",
        transform: open ? "translateY(0)" : "translateY(100%)",
        transition: `transform ${T}`,
        background: "#FFFFFF",
        borderTop: "1px solid #E5E5EA",
        borderRadius: "16px 16px 0 0",
        zIndex: 50,
        display: "flex",
        flexDirection: "column" as const,
        fontFamily: "var(--font-body)",
        overflow: "hidden",
      }
    : {
        position: "absolute" as const,
        top: 0,
        right: 0,
        bottom: 0,
        width: 320,
        transform: open ? "translateX(0)" : "translateX(100%)",
        transition: `transform ${T}`,
        background: "#FFFFFF",
        borderLeft: "1px solid #E5E5EA",
        zIndex: 50,
        display: "flex",
        flexDirection: "column" as const,
        fontFamily: "var(--font-body)",
        overflow: "hidden",
      };

  return (
    <div style={panelStyle}>
      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "14px 16px",
        borderBottom: "1px solid #E5E5EA",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{
            fontSize: 18,
            fontWeight: 700,
            color: "#1C1C1E",
            letterSpacing: "-0.02em",
          }}>
            {detail?.spotLabel ?? "—"}
          </span>
          {detail && (
            <span style={{
              fontSize: 10,
              fontWeight: 600,
              padding: "2px 8px",
              borderRadius: 4,
              background: statusColor + "18",
              color: statusColor,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}>
              {STATUS_LABELS[detail.status]}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          style={{
            width: 24,
            height: 24,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: "none",
            color: "#636366",
            fontSize: 16,
            cursor: "pointer",
            borderRadius: 4,
            fontFamily: "var(--font-body)",
          }}
        >
          &times;
        </button>
      </div>

      {/* Content */}
      <div style={{
        flex: 1,
        overflowY: "auto",
        padding: "16px",
      }}>
        {detail?.status === "VACANT" && (
          <div style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            gap: 8,
          }}>
            <div style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              background: "#DCFCE7",
              border: "1px solid #2D7A4A",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
              color: "#2D7A4A",
            }}>
              P
            </div>
            <span style={{ color: "#636366", fontSize: 12 }}>Spot is available</span>
          </div>
        )}

        {detail?.session && (
          <>
            {/* Driver */}
            <Section title="Driver">
              <Row label="Name" value={detail.session.driver.name} />
              <Row label="Phone" value={detail.session.driver.phone} />
              <Row label="Email" value={detail.session.driver.email ?? "—"} />
            </Section>

            {/* Vehicle */}
            <Section title="Vehicle">
              <Row label="Type" value={detail.session.vehicle.type === "TRUCK_TRAILER" ? "Truck + Trailer" : "Bobtail"} />
              {detail.session.vehicle.unitNumber && (
                <Row label="Truck #" value={detail.session.vehicle.unitNumber} />
              )}
              {detail.session.vehicle.licensePlate && (
                <Row label="Plate" value={detail.session.vehicle.licensePlate} />
              )}
              {detail.session.vehicle.nickname && (
                <Row label="Nickname" value={detail.session.vehicle.nickname} color="#6B7280" />
              )}
            </Section>

            {/* Session */}
            <Section title="Session">
              <Row label="Status" value={
                detail.session.sessionStatus === "OVERSTAY" ? "Overstay" : "Active"
              } color={
                detail.session.sessionStatus === "OVERSTAY" ? "#DC2626" : "#2D7A4A"
              } />
              <Row label="Checked in" value={formatDateTime(detail.session.startedAt)} />
              <Row label="Duration" value={timeAgo(detail.session.startedAt)} />
              <Row label="Expected end" value={formatDateTime(detail.session.expectedEnd)} />
              <Row
                label="Time left"
                value={timeUntil(detail.session.expectedEnd)}
                color={detail.session.expectedEnd < new Date() ? "#DC2626" : "#2D7A4A"}
              />
              {detail.session.reminderSent && (
                <Row label="Reminder" value="Sent" color="#B45309" />
              )}
            </Section>

            {/* Payments */}
            {detail.session.payments.length > 0 && (
              <Section title="Payments">
                {detail.session.payments.map((p, i) => (
                  <div
                    key={p.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "6px 0",
                      borderBottom: i < detail.session!.payments.length - 1 ? "1px solid #E5E5EA" : "none",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 12, color: "#1C1C1E", fontWeight: 500 }}>
                        {p.type === "CHECKIN" ? "Check-in" : p.type === "EXTENSION" ? "Extension" : "Overstay"}
                        {p.days ? ` (${p.days}d)` : ""}
                      </div>
                      <div style={{ fontSize: 10, color: "#8E8E93", marginTop: 1 }}>
                        {formatDateTime(p.createdAt)}
                      </div>
                    </div>
                    <span style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: p.type === "OVERSTAY" ? "#DC2626" : "#1C1C1E",
                      fontVariantNumeric: "tabular-nums",
                    }}>
                      ${p.amount.toFixed(2)}
                    </span>
                  </div>
                ))}
                {/* Total */}
                <div style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "8px 0 0",
                  marginTop: 4,
                  borderTop: "1px solid #E5E5EA",
                }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: "#636366" }}>Total</span>
                  <span style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: "#1C1C1E",
                    fontVariantNumeric: "tabular-nums",
                  }}>
                    ${detail.session.payments.reduce((s, p) => s + p.amount, 0).toFixed(2)}
                  </span>
                </div>
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
