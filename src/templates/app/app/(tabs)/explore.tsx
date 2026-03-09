import { StyleSheet, Text, View, FlatList } from "react-native";
import { useColorScheme } from "@/hooks/useColorScheme";
import { Colors } from "@/constants/Colors";

interface ExploreItem {
  id: string;
  title: string;
  description: string;
}

const PLACEHOLDER_DATA: ExploreItem[] = [
  { id: "1", title: "Feature One", description: "Explore the first feature of your app" },
  { id: "2", title: "Feature Two", description: "Discover what makes this unique" },
  { id: "3", title: "Feature Three", description: "Learn more about the possibilities" },
];

export default function ExploreScreen() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? "light"];

  const renderItem = ({ item }: { item: ExploreItem }) => (
    <View style={[styles.item, { backgroundColor: colors.card }]}>
      <Text style={[styles.itemTitle, { color: colors.text }]}>{item.title}</Text>
      <Text style={[styles.itemDescription, { color: colors.textSecondary }]}>
        {item.description}
      </Text>
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <FlatList
        data={PLACEHOLDER_DATA}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <Text style={[styles.header, { color: colors.text }]}>Explore</Text>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              Nothing to explore yet.
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  list: { padding: 20, paddingTop: 60 },
  header: { fontSize: 32, fontWeight: "700", marginBottom: 24 },
  item: {
    padding: 16,
    borderRadius: 12,
    marginBottom: 12,
  },
  itemTitle: { fontSize: 16, fontWeight: "600", marginBottom: 4 },
  itemDescription: { fontSize: 14, lineHeight: 20 },
  empty: { alignItems: "center", paddingVertical: 40 },
  emptyText: { fontSize: 16 },
});
