# Mobile App Template

**Pipeline**: app
**Category**: Mobile
**Stack**: Expo SDK 52, TypeScript, Expo Router v4, React Native

---

## Description

A production-ready Expo React Native mobile app with tab navigation, dark mode support, and a clean component architecture. The base template provides the shell; variants add domain-specific features.

---

## Pre-Configured Features

- Tab navigation with 3 tabs (Home, Explore, Profile)
- Dark/light mode with system preference detection
- Color token system (constants/Colors.ts)
- Typed useColorScheme hook
- StatusBar integration
- Card-based UI components
- ScrollView and FlatList patterns

---

## File Structure

```
<project>/
├── app.json
├── package.json
├── tsconfig.json
├── app/
│   ├── _layout.tsx           # Root layout with StatusBar
│   └── (tabs)/
│       ├── _layout.tsx       # Tab navigator (Home, Explore, Profile)
│       ├── index.tsx         # Home screen (hero + cards)
│       ├── explore.tsx       # Explore screen (FlatList)
│       └── profile.tsx       # Profile screen (avatar + actions)
├── hooks/
│   └── useColorScheme.ts
├── constants/
│   └── Colors.ts
├── components/               # AI generates domain-specific components
├── services/                 # AI generates API/data services
└── store/                    # AI generates state management
```

---

## Default Tech Stack

| Component | Technology |
|---|---|
| Framework | Expo SDK 52 |
| Navigation | Expo Router v4 |
| Language | TypeScript (strict) |
| Icons | @expo/vector-icons (Ionicons) |
| State | Zustand (added by AI when needed) |
| Storage | expo-sqlite + AsyncStorage (added by AI when needed) |

---

## Usage

During Phase 0 intent normalization, this template:

1. Provides the base file structure as context to the AI
2. Tells the AI which files already exist (don't regenerate)
3. Focuses AI generation on custom screens, components, and business logic
4. Applies prompt enhancement from matched variant (if any)

**Example prompt enhancement:**
- User says: "fitness tracker"
- AI adds: workout logging, exercise library, progress charts, streak tracking, rest day scheduling

---

## Quality Checklist

- [ ] All tabs navigate correctly
- [ ] Dark mode renders without color issues
- [ ] Home screen loads without errors
- [ ] Custom components use Colors token system
- [ ] No hardcoded color values outside Colors.ts
- [ ] TypeScript strict mode passes
- [ ] No console.log statements (use __DEV__ guards)
- [ ] Pressable components have proper touch feedback
- [ ] FlatList uses keyExtractor
- [ ] ScrollView content doesn't overflow
