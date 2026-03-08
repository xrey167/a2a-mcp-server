# Marketplace — API Variant

**Pipeline**: api
**Category**: Backend / E-Commerce
**Complexity**: High

---

## Description

A marketplace API with users, listings, orders, reviews, and search. Supports multi-vendor workflows with buyer/seller roles, listing management, and transaction tracking.

---

## Ideal For

- Marketplace backends
- Classified ad APIs
- Service booking platforms
- Rental platforms
- Auction systems
- Peer-to-peer trading APIs

---

## Pre-Configured Features

- User accounts with buyer/seller roles
- Listing CRUD with status workflow (draft → active → sold)
- Category/tag system for listings
- Full-text search with FTS5
- Order workflow (created → paid → shipped → delivered)
- Review/rating system with averages
- Image URL management per listing
- Pagination and filtering on all list endpoints

---

## Usage

**Prompt Enhancement:**
- Add user entity with role (buyer, seller, admin)
- Add listings with title, description, price, images, status, category
- Add listing status workflow (draft → active → sold → archived)
- Add categories table with parent/child hierarchy
- Add orders with buyer, seller, listing, status, timestamps
- Add reviews with rating (1-5), text, buyer/seller references
- Add FTS5 search across listing title and description
- Add aggregate endpoints (seller stats, category counts)
- Add image URL array support per listing

---

## Quality Checklist

- [ ] Users can only edit their own listings
- [ ] Listing status transitions follow valid workflow
- [ ] Orders reference valid listings and users
- [ ] Reviews only allowed for completed orders
- [ ] FTS5 search returns relevant results
- [ ] Category hierarchy loads correctly
- [ ] Aggregate endpoints return accurate counts
- [ ] Role-based access prevents unauthorized operations
- [ ] Price stored as integer cents (not float)
