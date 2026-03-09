# Portfolio — Website Variant

**Pipeline**: website
**Category**: Personal / Professional
**Complexity**: Medium

---

## Description

A professional portfolio website showcasing projects, skills, and experience. Clean, modern design with smooth animations, project case studies, and a contact form.

---

## Ideal For

- Developer portfolios
- Designer portfolios
- Freelancer websites
- Creative professional sites
- Agency showcase sites
- Artist portfolios

---

## Pre-Configured Features

### Core Features

- Hero section with name, title, and CTA
- Project showcase grid with filter by category
- Project detail pages with case study format
- About page with skills, experience timeline, and bio
- Contact form with client-side validation
- Responsive design (mobile-first)
- Smooth scroll animations on reveal

### UI Components

- Project card with image, title, tags, and hover overlay
- Skills grid with proficiency indicators
- Timeline component for experience/education
- Contact form with floating labels
- Navigation with active section highlighting
- Back-to-top button

---

## File Structure

```
<project>/
├── src/app/
│   ├── page.tsx              # Landing (hero + featured projects + about)
│   ├── projects/
│   │   ├── page.tsx          # All projects with filter
│   │   └── [slug]/page.tsx   # Project case study
│   ├── about/page.tsx        # Full about + skills + timeline
│   └── contact/page.tsx      # Contact form
├── src/components/
│   ├── ProjectCard.tsx
│   ├── SkillsGrid.tsx
│   ├── Timeline.tsx
│   └── ContactForm.tsx
├── src/data/
│   └── projects.ts           # Project data (mock)
```

---

## Usage

**Prompt Enhancement:**
- Add project grid with category filter (All, Web, Mobile, Design, etc.)
- Add project detail pages with problem/solution/result case study format
- Add about page with bio, skills chart, and experience timeline
- Add contact form with name, email, message validation (Zod)
- Add smooth reveal animations on scroll (intersection observer)
- Add responsive image grid with aspect ratio preservation
- Add SEO metadata per page

---

## Quality Checklist

- [ ] All pages render at mobile, tablet, desktop
- [ ] Project filter works without page reload
- [ ] Project detail pages load correct content
- [ ] Contact form validates before submission
- [ ] Scroll animations trigger at correct viewport position
- [ ] Navigation highlights current section/page
- [ ] Images have proper alt text and sizing
- [ ] Page transitions are smooth
