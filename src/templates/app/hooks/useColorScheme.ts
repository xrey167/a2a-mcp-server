import { useColorScheme as useRNColorScheme } from "react-native";

/**
 * Typed wrapper around React Native's useColorScheme.
 * Returns "light" | "dark" — never null.
 */
export function useColorScheme(): "light" | "dark" {
  return useRNColorScheme() ?? "light";
}
