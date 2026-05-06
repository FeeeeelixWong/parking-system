"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export type Toast = {
  id: string;
  type: "success" | "error";
  message: string;
  actionLabel?: string;
  onAction?: () => void;
};

type ToastInput = Omit<Toast, "id">;
type Ctx = { addToast: (t: ToastInput) => void };

const ToastCtx = createContext<Ctx>({ addToast: () => {} });
export const useToast = () => useContext(ToastCtx);

// ─── Single toast ─────────────────────────────────────────────────────────────

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (toast.type === "success") {
      timerRef.current = setTimeout(onDismiss, 4000);
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [toast.id, toast.type, onDismiss]);

  const isOk = toast.type === "success";
  const bg = isOk ? "#DCFCE7" : "#FEF2F2";
  const border = isOk ? "#86EFAC" : "#FCA5A5";
  const fg = isOk ? "#166534" : "#991B1B";
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 10,
      background: bg, border: `1px solid ${border}`, borderRadius: 8,
      padding: "12px 14px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.14)",
      minWidth: 280, maxWidth: 400,
      fontFamily: "var(--font-body)",
      animation: "toast-in 0.18s ease",
    }}>
      <div style={{ flex: 1, fontSize: 13, color: fg, lineHeight: 1.5 }}>
        {toast.message}
        {toast.actionLabel && toast.onAction && (
          <button
            onClick={toast.onAction}
            style={{
              display: "block", marginTop: 6,
              fontSize: 12, fontWeight: 600, color: fg,
              background: "transparent", border: `1px solid ${border}`,
              borderRadius: 4, padding: "3px 8px", cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {toast.actionLabel}
          </button>
        )}
      </div>
      <button
        onClick={onDismiss}
        style={{
          background: "transparent", border: "none",
          color: fg, fontSize: 18, cursor: "pointer",
          lineHeight: 1, padding: "0 2px", flexShrink: 0, opacity: 0.6,
        }}
      >
        ×
      </button>
    </div>
  );
}

// ─── Stack ────────────────────────────────────────────────────────────────────

function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <>
      <style>{`@keyframes toast-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <div style={{
        position: "fixed", bottom: 24, right: 24, zIndex: 9999,
        display: "flex", flexDirection: "column-reverse", gap: 10,
        alignItems: "flex-end", pointerEvents: "none",
      }}>
        {toasts.map((t) => (
          <div key={t.id} style={{ pointerEvents: "auto" }}>
            <ToastItem toast={t} onDismiss={() => onDismiss(t.id)} />
          </div>
        ))}
      </div>
    </>
  );
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((t: ToastInput) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { ...t, id }]);
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastCtx.Provider value={{ addToast }}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </ToastCtx.Provider>
  );
}
