# Website Template

**Pipeline**: website
**Category**: Web
**Stack**: Next.js 15, TypeScript, Tailwind CSS v4, React 19

---

## Description

A modern Next.js website with App Router, Tailwind CSS v4, responsive design, and a polished landing page structure. Includes header navigation, hero section, features grid, about section, CTA block, and footer.

---

## Pre-Configured Features

- Next.js 15 App Router with layout.tsx and page.tsx
- Tailwind CSS v4 with CSS custom properties for theming
- Dark mode via prefers-color-scheme
- Responsive navigation header with CTA button
- Hero section with headline and dual CTAs
- 3-column features grid with hover effects
- About section
- Full-width CTA block with accent background
- Footer with copyright

---

## File Structure

```
<project>/
├── package.json
├── tsconfig.json
├── next.config.ts
├── postcss.config.mjs
├── src/
│   └── app/
│       ├── globals.css       # Tailwind imports + CSS custom properties
│       ├── layout.tsx        # Root layout with nav + footer
│       └── page.tsx          # Landing page (hero, features, about, CTA)
├── src/components/           # AI generates custom components
├── src/lib/                  # AI generates utilities
└── public/                   # Static assets
```

---

## Default Tech Stack

| Component | Technology |
|---|---|
| Framework | Next.js 15 (App Router) |
| Language | TypeScript (strict) |
| Styling | Tailwind CSS v4 |
| PostCSS | @tailwindcss/postcss |
| React | 19.x |

---

## Usage

During Phase 0, this template provides the base structure. The AI generates additional pages, components, and features based on the spec.

**Example prompt enhancement:**
- User says: "portfolio website"
- AI adds: project grid with filters, case study detail pages, about page with timeline, contact form with validation, blog with MDX, smooth scroll animations

---

## Quality Checklist

- [ ] Site renders at all breakpoints (mobile, tablet, desktop)
- [ ] Navigation links work correctly
- [ ] Dark mode renders without contrast issues
- [ ] No layout shift on page load (CLS < 0.1)
- [ ] All images have alt text
- [ ] Heading hierarchy is semantic (h1 → h2 → h3)
- [ ] Interactive elements have hover/focus states
- [ ] Color contrast meets WCAG AA (4.5:1 for text)
- [ ] Pages have proper meta titles and descriptions
- [ ] No unused CSS custom properties
