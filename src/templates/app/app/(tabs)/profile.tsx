import { StyleSheet, Text, View, Pressable } from "react-native";
import { useColorScheme } from "@/hooks/useColorScheme";
import { Colors } from "@/constants/Colors";

export default function ProfileScreen() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? "light"];

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.content}>
        <View style={[styles.avatar, { backgroundColor: colors.tint }]}>
          <Text style={styles.avatarText}>U</Text>
        </View>

        <Text style={[styles.name, { color: colors.text }]}>User Name</Text>
        <Text style={[styles.email, { color: colors.textSecondary }]}>
          user@example.com
        </Text>

        <View style={styles.actions}>
          <Pressable
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: colors.tint, opacity: pressed ? 0.8 : 1 },
            ]}
          >
            <Text style={styles.buttonText}>Edit Profile</Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [
              styles.buttonOutline,
              { borderColor: colors.border, opacity: pressed ? 0.8 : 1 },
            ]}
          >
            <Text style={[styles.buttonOutlineText, { color: colors.text }]}>
              Settings
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { alignItems: "center", paddingTop: 80, padding: 20 },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  avatarText: { color: "#fff", fontSize: 32, fontWeight: "700" },
  name: { fontSize: 24, fontWeight: "600", marginBottom: 4 },
  email: { fontSize: 14, marginBottom: 32 },
  actions: { width: "100%", gap: 12 },
  button: {
    padding: 16,
    borderRadius: 12,
    alignItems: "center",
  },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  buttonOutline: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
  },
  buttonOutlineText: { fontSize: 16, fontWeight: "600" },
});
