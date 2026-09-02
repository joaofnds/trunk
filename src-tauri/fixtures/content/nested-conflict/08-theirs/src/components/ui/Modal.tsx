import React from "react";

type ModalSize = "sm" | "md" | "lg" | "fullscreen";

interface ModalProps {
  title: string;
  isOpen: boolean;
  size?: ModalSize;
  closable?: boolean;
  onClose: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

export function Modal({ title, isOpen, size = "md", closable = true, onClose, footer, children }: ModalProps) {
  if (!isOpen) return null;

  const handleOverlayClick = closable ? onClose : undefined;

  return (
    <div className="modal-overlay" onClick={handleOverlayClick} role="dialog" aria-modal="true">
      <div className={`modal-content modal-${size}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          {closable && <button className="modal-close" onClick={onClose} aria-label="Close">X</button>}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
