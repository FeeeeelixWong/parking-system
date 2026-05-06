"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { QRCodeSVG } from "qrcode.react";

export default function Home() {
  const origin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => "",
  );
  const entryUrl = origin ? `${origin}/entry` : "";
  const exitUrl = origin ? `${origin}/exit` : "";

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--dark-bg)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 40,
        padding: "40px 20px",
        fontFamily: "var(--font-body)",
      }}
    >
      {/* Logo / title */}
      <div style={{ textAlign: "center" }}>
        <h1
          style={{
            fontSize: 28,
            fontWeight: 800,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--dark-fg)",
            fontFamily: "var(--font-display)",
            margin: 0,
          }}
        >
          Parking System
        </h1>
        <p style={{ color: "var(--dark-fg-subtle)", fontSize: 13, marginTop: 6 }}>
          Sistema de Gestión de Estacionamiento
        </p>
      </div>

      {/* QR Codes — Entry and Exit */}
      {entryUrl && (
        <div style={{ display: "flex", gap: 16, width: "100%", maxWidth: 420, flexWrap: "wrap", justifyContent: "center" }}>
          <QRCard url={entryUrl} label="Entry Gate" sublabel="/entry" color="var(--dark-green)" />
          <QRCard url={exitUrl} label="Exit Gate" sublabel="/exit" color="#0A84FF" />
        </div>
      )}

      {/* Cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16, width: "100%", maxWidth: 360 }}>
        {/* Scan / gate */}
        <Link href="/entry" style={{ textDecoration: "none" }}>
          <div
            className="hover:scale-[1.02] transition-all duration-150"
            style={{
              background: "linear-gradient(135deg, #0D2B1A 0%, #061508 100%)",
              border: "1px solid color-mix(in srgb, var(--dark-green) 25%, transparent)",
              borderRadius: 16,
              padding: "20px 24px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 14,
            }}
          >
            <div style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: "var(--dark-green)",
              flexShrink: 0,
            }} />
            <div>
              <div style={{
                fontSize: 17,
                fontWeight: 700,
                color: "var(--dark-fg)",
                fontFamily: "var(--font-display)",
                letterSpacing: "0.02em",
              }}>
                Gate Access
              </div>
              <div style={{
                fontSize: 12,
                color: "var(--dark-green)",
                fontWeight: 600,
                marginTop: 2,
              }}>
                Scan QR · open gate
              </div>
            </div>
          </div>
        </Link>

        {/* Demo check-in — primary CTA */}
        <Link href="/checkin?demo=1" style={{ textDecoration: "none" }}>
          <div
            className="hover:scale-[1.02] transition-all duration-150"
            style={{
              background: "linear-gradient(135deg, #0A2A50 0%, #061830 100%)",
              border: "1px solid color-mix(in srgb, var(--dark-blue) 27%, transparent)",
              borderRadius: 16,
              padding: "24px 24px",
              cursor: "pointer",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 10 }}>
              <div style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                background: "var(--dark-blue)",
                flexShrink: 0,
              }} />
              <div>
                <div style={{
                  fontSize: 17,
                  fontWeight: 700,
                  color: "var(--dark-fg)",
                  fontFamily: "var(--font-display)",
                  letterSpacing: "0.02em",
                }}>
                  Driver Demo
                </div>
                <div style={{
                  fontSize: 12,
                  color: "var(--dark-blue)",
                  fontWeight: 600,
                  marginTop: 2,
                }}>
                  No payment · Spot assigned instantly
                </div>
              </div>
            </div>
            <p style={{
              fontSize: 13,
              color: "var(--dark-fg-muted)",
              margin: 0,
              lineHeight: 1.5,
            }}>
              Fill out the check-in form, get randomly assigned a spot, and see navigation on the live lot map.
            </p>
          </div>
        </Link>

        {/* Secondary cards */}
        <SecondaryCard href="/lot" title="Lot Map" subtitle="View & edit parking lot layout" />
        <SecondaryCard href="/checkin" title="Check In" subtitle="Full flow with payment" />
        <SecondaryCard href="/admin" title="Admin" subtitle="Dashboard & session history" />
      </div>
    </div>
  );
}

function QRCard({ url, label, sublabel, color }: { url: string; label: string; sublabel: string; color: string }) {
  return (
    <div style={{
      background: "var(--dark-card)",
      border: "1px solid var(--dark-border)",
      borderRadius: 14,
      padding: 18,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 10,
      flex: "1 1 180px",
      maxWidth: 200,
    }}>
      <div style={{ background: "#fff", padding: 10, borderRadius: 8, lineHeight: 0, minWidth: 120, minHeight: 120 }}>
        {url && <QRCodeSVG value={url} size={120} />}
      </div>
      <div style={{ textAlign: "center" }}>
        <div style={{
          fontSize: 13,
          fontWeight: 700,
          color,
          fontFamily: "var(--font-display)",
          letterSpacing: "0.04em",
        }}>
          {label}
        </div>
        <div style={{
          fontSize: 10,
          color: "var(--dark-fg-subtle)",
          marginTop: 3,
          fontFamily: "monospace",
        }}>
          {sublabel}
        </div>
      </div>
    </div>
  );
}

function SecondaryCard({
  href,
  title,
  subtitle,
}: {
  href: string;
  title: string;
  subtitle: string;
}) {
  return (
    <Link href={href} style={{ textDecoration: "none" }}>
      <div
        className="hover:bg-[var(--dark-border)] transition-colors duration-150"
        style={{
          background: "var(--dark-card)",
          border: "1px solid var(--dark-border)",
          borderRadius: 12,
          padding: "18px 20px",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
        }}
      >
        <div>
          <div style={{
            fontSize: 15,
            fontWeight: 600,
            color: "var(--dark-fg)",
            fontFamily: "var(--font-display)",
          }}>
            {title}
          </div>
          <div style={{
            fontSize: 12,
            color: "var(--dark-fg-subtle)",
            marginTop: 2,
          }}>
            {subtitle}
          </div>
        </div>
      </div>
    </Link>
  );
}
