import React from "react";

interface ModalProps {
  title: string;
  subtitle?: string;
  isOpen: boolean;
  onClose: () => void;
  onConfirm?: () => void;
  confirmLabel?: string;
  children: React.ReactNode;
}

export function Modal({ title, subtitle, isOpen, onClose, onConfirm, confirmLabel = "OK", children }: ModalProps) {
  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2 className="modal-title">{title}</h2>
          {subtitle && <p className="modal-subtitle">{subtitle}</p>}
          <button className="modal-close-btn" onClick={onClose}>&times;</button>
        </header>
        <section className="modal-body">{children}</section>
        {onConfirm && (
          <footer className="modal-actions">
            <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn--primary" onClick={onConfirm}>{confirmLabel}</button>
          </footer>
        )}
      </div>
    </div>
  );
}
