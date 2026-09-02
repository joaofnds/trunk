import React from "react";

type ButtonVariant = "primary" | "secondary" | "danger" | "outline" | "text";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps {
  label: string;
  variant: ButtonVariant;
  size: ButtonSize;
  disabled?: boolean;
  fullWidth?: boolean;
  type?: "button" | "submit" | "reset";
  onClick: () => void;
}

export function Button({ label, variant, size, disabled, fullWidth, type = "button", onClick }: ButtonProps) {
  const classNames = [
    "btn",
    `btn--${variant}`,
    `btn--${size}`,
    fullWidth ? "btn--full-width" : "",
  ].filter(Boolean).join(" ");

  return (
    <button
      type={type}
      className={classNames}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
