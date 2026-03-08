# SaaS Starter — Mobile App Variant

**Pipeline**: app
**Category**: Productivity / Business
**Complexity**: Medium

---

## Description

A subscription-based productivity mobile app with dashboard, onboarding flow, and RevenueCat-style monetization patterns. Perfect for habit trackers, task managers, note apps, and similar SaaS products.

---

## Ideal For

- Habit tracking apps
- Task management apps
- Note-taking apps
- Personal finance tools
- Fitness tracking apps
- Learning / education apps
- Time tracking apps
- Journal / diary apps

---

## Pre-Configured Features

### Core Features

- User onboarding flow with value proposition slides
- Dashboard home screen with key metrics cards
- Settings screen with account management
- Subscription integration (monthly/yearly tiers)
- Offline-first data persistence with SQLite
- Streak tracking and progress visualization

### UI Components

- Card-based dashboard layout
- Progress indicators and charts
- Pull-to-refresh patterns
- Skeleton loading states
- Bottom sheet modals
- Segmented controls for data views

### Monetization

- Freemium model with feature gating
- 7-day free trial for premium
- Monthly: $9.99/month
- Yearly: $79.99/year (33% savings)
- Paywall screen with feature comparison

---

## File Structure

```
<project>/
├── app/
│   ├── _layout.tsx
│   ├── index.tsx             # Splash/landing
│   ├── (tabs)/
│   │   ├── _layout.tsx
│   │   ├── home.tsx          # Dashboard with metrics
│   │   ├── features.tsx      # Main feature area
│   │   ├── profile.tsx       # User profile
│   │   └── settings.tsx      # Settings
│   ├── onboarding/
│   │   ├── _layout.tsx
│   │   └── index.tsx         # Onboarding slides
│   └── paywall.tsx           # Subscription screen
├── src/
│   ├── components/
│   │   ├── Dashboard/        # Metrics cards, charts
│   │   ├── Cards/            # Reusable card variants
│   │   └── Charts/           # Progress visualization
│   ├── services/
│   │   └── purchases.ts      # Subscription management
│   ├── hooks/
│   │   └── usePremium.ts     # Premium feature gating
│   └── store/
│       └── appStore.ts       # Zustand store
```

---

## Default Tech Stack

| Component | Technology |
|---|---|
| Framework | Expo SDK 52 |
| Navigation | Expo Router v4 |
| State | Zustand |
| Storage | expo-sqlite + AsyncStorage |
| Charts | Victory Native |
| Icons | Lucide React Native |

---

## Usage

When this variant matches, inject these domain concepts into the normalized spec:

**Prompt Enhancement:**
- Add dashboard with key metrics cards and skeleton loading
- Add onboarding flow (3-4 slides) that only shows on first launch
- Add premium gating hook (usePremium) for subscription features
- Add streak tracking with calendar visualization
- Add settings with data export, notification preferences, account management
- Add pull-to-refresh on data screens
- Add offline-first SQLite persistence with sync indicators
- Structure the app around a daily/weekly usage loop

**Example:**
- User says: "habit tracker"
- Enhanced to: "A habit tracking app with dashboard showing daily streaks, completion rates, and weekly progress charts. Features habit creation with custom schedules, reminder notifications, streak calendar visualization, and data export. Premium tier unlocks unlimited habits, detailed analytics, and custom categories."

---

## Quality Checklist

- [ ] Dashboard loads with skeleton states before data
- [ ] All tabs navigate correctly
- [ ] Onboarding completes and doesn't repeat on next launch
- [ ] Paywall displays subscription options
- [ ] Premium features are properly gated (usePremium hook)
- [ ] Offline mode works — data persists without network
- [ ] Charts render with real or mock data
- [ ] Pull-to-refresh works on data screens
- [ ] Settings screen has all expected options
- [ ] Streak counter increments correctly

---

## Customization Points

- Subscription tiers and pricing in services/purchases.ts
- Dashboard metric cards in components/Dashboard/
- Tab structure in (tabs)/_layout.tsx
- Onboarding slide content in onboarding/index.tsx
- Color scheme in constants/Colors.ts
- Premium feature set in hooks/usePremium.ts
