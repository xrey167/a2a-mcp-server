import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useColorScheme } from "@/hooks/useColorScheme";

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <>
      <StatusBar style={colorScheme === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerStyle: {
            backgroundColor: colorScheme === "dark" ? "#1a1a2e" : "#ffffff",
          },
          headerTintColor: colorScheme === "dark" ? "#e0e0e0" : "#1a1a2e",
          headerTitleStyle: { fontWeight: "600" },
          contentStyle: {
            backgroundColor: colorScheme === "dark" ? "#0f0f1a" : "#f5f5f7",
          },
        }}
      />
    </>
  );
}
