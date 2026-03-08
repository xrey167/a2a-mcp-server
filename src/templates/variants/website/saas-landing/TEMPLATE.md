# SaaS Landing — Website Variant

**Pipeline**: website
**Category**: Marketing / Business
**Complexity**: Medium

---

## Description

A high-converting SaaS landing page with pricing table, testimonials, feature breakdown, FAQ, and email capture. Designed for product launches and B2B marketing.

---

## Ideal For

- SaaS product launches
- B2B service pages
- Product marketing sites
- Startup landing pages
- App download pages
- Waitlist / coming soon pages

---

## Pre-Configured Features

### Core Features

- Hero with headline, subheadline, CTA, and product screenshot
- Feature section with icon grid (6-8 features)
- How it works section (3-step process)
- Pricing table (Free, Pro, Enterprise) with feature comparison
- Testimonial carousel with avatars and quotes
- FAQ accordion
- Email capture / waitlist form
- Footer with social links and legal pages

### UI Components

- Pricing card with recommended badge
- Testimonial card with star rating
- Feature card with icon
- FAQ accordion with smooth expand
- Email input with submit button
- Badge / pill components for labels
- Gradient backgrounds and dividers

---

## File Structure

```
<project>/
├── src/app/
│   ├── page.tsx              # Full landing page (all sections)
│   ├── pricing/page.tsx      # Detailed pricing comparison
│   └── waitlist/page.tsx     # Email capture / waitlist
├── src/components/
│   ├── PricingCard.tsx
│   ├── TestimonialCarousel.tsx
│   ├── FeatureGrid.tsx
│   ├── FAQ.tsx
│   └── EmailCapture.tsx
├── src/data/
│   ├── pricing.ts            # Plan definitions
│   ├── testimonials.ts       # Mock testimonials
│   └── faq.ts                # FAQ items
```

---

## Usage

**Prompt Enhancement:**
- Add hero section with product screenshot or mockup placeholder
- Add 6-8 feature cards with icons and short descriptions
- Add 3-tier pricing table (Free/Pro/Enterprise) with feature comparison
- Add testimonial carousel with 4-6 mock testimonials
- Add FAQ accordion with 6-8 common questions
- Add email capture form with validation
- Add "How it works" 3-step visual section
- Add trust badges / social proof section (logos, stats)
- Add sticky CTA that appears on scroll past hero
- Optimize for conversion: single primary CTA color throughout

---

## Quality Checklist

- [ ] Hero CTA is visually prominent and clickable
- [ ] Pricing cards align at all breakpoints
- [ ] Pricing toggle (monthly/yearly) updates prices
- [ ] Testimonial carousel navigates correctly
- [ ] FAQ accordion expands/collapses smoothly
- [ ] Email form validates before submission
- [ ] Page loads fast (no heavy images without lazy loading)
- [ ] All sections have proper spacing and hierarchy
- [ ] Mobile layout stacks correctly
- [ ] Social proof section shows realistic data
