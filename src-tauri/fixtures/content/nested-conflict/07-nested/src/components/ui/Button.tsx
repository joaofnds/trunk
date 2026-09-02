import React from "react";

interface ButtonProps {
  label: string;
  variant: "primary" | "secondary" | "danger";
  size: "sm" | "md" | "lg";
  disabled?: boolean;
  onClick: () => void;
}

export function Button({ label, variant, size, disabled, onClick }: ButtonProps) {
  const baseClass = "btn";
  const variantClass = `btn-${variant}`;
  const sizeClass = `btn-${size}`;

  return (
    <button
      className={`${baseClass} ${variantClass} ${sizeClass}`}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
