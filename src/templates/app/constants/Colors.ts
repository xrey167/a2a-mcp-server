/**
 * Color tokens for light and dark themes.
 * Extend these as the app grows — all colors should be sourced from here.
 */
export const Colors = {
  light: {
    text: "#1a1a2e",
    textSecondary: "#6b7280",
    background: "#f5f5f7",
    card: "#ffffff",
    tint: "#6366f1",
    border: "#e5e7eb",
    tabIconDefault: "#9ca3af",
    tabIconSelected: "#6366f1",
  },
  dark: {
    text: "#e0e0e0",
    textSecondary: "#9ca3af",
    background: "#0f0f1a",
    card: "#1a1a2e",
    tint: "#818cf8",
    border: "#374151",
    tabIconDefault: "#6b7280",
    tabIconSelected: "#818cf8",
  },
} as const;
