import { StyleSheet, Text, View, ScrollView, Pressable } from "react-native";
import { useColorScheme } from "@/hooks/useColorScheme";
import { Colors } from "@/constants/Colors";

export default function HomeScreen() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? "light"];

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
    >
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]}>
          {{name}}
        </Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          {{description}}
        </Text>
      </View>

      <View style={styles.cardContainer}>
        <Pressable
          style={({ pressed }) => [
            styles.card,
            { backgroundColor: colors.card, opacity: pressed ? 0.8 : 1 },
          ]}
        >
          <Text style={[styles.cardTitle, { color: colors.text }]}>
            Get Started
          </Text>
          <Text style={[styles.cardDescription, { color: colors.textSecondary }]}>
            Start building your app by editing this screen.
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 20, paddingTop: 60 },
  header: { marginBottom: 32 },
  title: { fontSize: 32, fontWeight: "700", marginBottom: 8 },
  subtitle: { fontSize: 16, lineHeight: 24 },
  cardContainer: { gap: 16 },
  card: {
    padding: 20,
    borderRadius: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  cardTitle: { fontSize: 18, fontWeight: "600", marginBottom: 8 },
  cardDescription: { fontSize: 14, lineHeight: 20 },
});
