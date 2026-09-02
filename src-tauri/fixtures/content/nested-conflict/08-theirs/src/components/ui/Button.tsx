import React from "react";

interface ButtonProps {
  label: string;
  variant: "primary" | "secondary" | "danger" | "ghost" | "link";
  size: "xs" | "sm" | "md" | "lg" | "xl";
  disabled?: boolean;
  loading?: boolean;
  icon?: React.ReactNode;
  onClick: () => void;
}

export function Button({ label, variant, size, disabled, loading, icon, onClick }: ButtonProps) {
  const classes = [
    "btn",
    `btn-${variant}`,
    `btn-${size}`,
    loading ? "btn-loading" : "",
    disabled ? "btn-disabled" : "",
  ].filter(Boolean).join(" ");

  return (
    <button
      className={classes}
      disabled={disabled || loading}
      onClick={onClick}
      aria-busy={loading}
    >
      {loading && <span className="btn-spinner" />}
      {icon && <span className="btn-icon">{icon}</span>}
      <span className="btn-label">{label}</span>
    </button>
  );
}
