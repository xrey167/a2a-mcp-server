# Social App — Mobile App Variant

**Pipeline**: app
**Category**: Social / Community
**Complexity**: High

---

## Description

A social content-sharing app with feed, posts, likes, comments, user profiles, and follow system. Supports text and image posts with infinite scroll and real-time-style interactions.

---

## Ideal For

- Photo sharing apps
- Community forums
- Social networks
- Micro-blogging platforms
- Discussion boards
- Content curation apps
- Fan community apps

---

## Pre-Configured Features

### Core Features

- Infinite scroll feed with pull-to-refresh
- Post creation (text + optional image)
- Like/unlike with animation and haptics
- Comment system with nested replies
- User profiles with follow/unfollow
- Notification feed (likes, comments, follows)
- Explore/discover with trending content
- User search

### UI Components

- Post card (avatar, content, actions, timestamp)
- Like button with spring animation
- Comment thread with indentation
- Profile header (avatar, bio, stats)
- Follow button with state toggle
- FAB (floating action button) for post creation
- Notification list with read/unread states
- FlashList for performant infinite scroll

### Monetization

- Premium badge and verification
- Ad-free experience
- Monthly: $2.99/mo or $24.99/yr

---

## File Structure

```
<project>/
├── app/
│   ├── (tabs)/
│   │   ├── feed.tsx          # Home feed (infinite scroll)
│   │   ├── explore.tsx       # Discover / trending
│   │   ├── notifications.tsx # Activity feed
│   │   └── profile.tsx       # Current user profile
│   ├── post/[id].tsx         # Post detail + comments
│   ├── user/[id].tsx         # Other user profile
│   └── create/
│       └── index.tsx         # New post composer
├── src/
│   ├── components/
│   │   ├── Post/
│   │   │   ├── PostCard.tsx
│   │   │   ├── PostActions.tsx
│   │   │   └── PostMedia.tsx
│   │   ├── Comment/
│   │   ├── Profile/
│   │   └── Feed/
│   ├── store/
│   │   ├── feedStore.ts
│   │   ├── profileStore.ts
│   │   └── notificationStore.ts
│   ├── services/
│   │   └── api.ts            # Mock social API
│   └── types/
│       └── social.ts
```

---

## Default Tech Stack

| Component | Technology |
|---|---|
| Framework | Expo SDK 52 |
| Navigation | Expo Router v4 |
| State | Zustand (feed, profile, notifications) |
| Lists | @shopify/flash-list |
| Animations | react-native-reanimated |
| Images | expo-image |
| Haptics | expo-haptics |

---

## Usage

**Prompt Enhancement:**
- Add infinite scroll feed with optimistic like updates
- Add post creation with text + image picker (expo-image-picker)
- Add like animation (scale bounce + haptic) on tap
- Add comment system with reply threading
- Add user profiles with follower/following counts
- Add follow/unfollow with optimistic state update
- Add notification feed with badge count on tab
- Add explore page with trending/popular content
- Use mock data (20+ posts, 5+ users) with realistic avatars
- Add FAB on feed screen for quick post creation

**Example:**
- User says: "pet photo sharing app"
- Enhanced to: "A pet photo sharing community where users post photos of their pets with breed tags. Features a scrollable feed with double-tap to like (heart animation), comments with pet emoji reactions, user profiles showing pet gallery, explore page with breed-based categories, and weekly 'cutest pet' voting."

---

## Quality Checklist

- [ ] Feed loads with posts and smooth infinite scroll
- [ ] Like animation plays on tap with haptic feedback
- [ ] Post creation saves and appears in feed
- [ ] Comments load on post detail screen
- [ ] User profile shows correct post count and followers
- [ ] Follow/unfollow updates UI immediately (optimistic)
- [ ] Notification badge shows unread count
- [ ] Explore page shows different content than feed
- [ ] Pull-to-refresh loads new content
- [ ] Empty states for no posts, no notifications, no followers
- [ ] FAB navigates to post creation

---

## Customization Points

- Post data model in types/social.ts
- Feed algorithm in store/feedStore.ts
- Post card layout in components/Post/PostCard.tsx
- Like animation in components/Post/PostActions.tsx
- Comment threading depth in components/Comment/
- Profile layout in components/Profile/
- Notification types in store/notificationStore.ts
