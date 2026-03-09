# CRUD Service — API Variant

**Pipeline**: api
**Category**: Backend / Data
**Complexity**: Low-Medium

---

## Description

A straightforward REST API with multiple entities, relationships, and full CRUD operations. Follows RESTful conventions with proper HTTP methods, status codes, and pagination.

---

## Ideal For

- Todo / task APIs
- Blog / CMS backends
- Inventory management APIs
- Contact / address book APIs
- Simple data management services
- Internal tools backends

---

## Pre-Configured Features

- Multiple related entities with foreign keys
- Full CRUD per entity (GET, POST, PUT, DELETE)
- List endpoints with pagination (limit/offset)
- Search/filter query parameters
- Sorting by multiple fields
- Input validation with error messages
- Relationship loading (joins)

---

## Usage

**Prompt Enhancement:**
- Add multiple entities based on the spec's data model
- Add foreign key relationships between entities
- Add list endpoints with pagination (limit, offset, total)
- Add search/filter via query parameters
- Add sorting (sort_by, order)
- Add input validation with descriptive error messages
- Add seed data script for development
- Follow RESTful URL conventions (/api/resources/:id)

---

## Quality Checklist

- [ ] All CRUD operations work for every entity
- [ ] Pagination returns correct total count
- [ ] Filters narrow results correctly
- [ ] Sorting works in both directions
- [ ] Foreign key constraints prevent orphaned records
- [ ] Input validation rejects invalid data with clear messages
- [ ] DELETE cascades or blocks based on relationships
- [ ] 404 returned for non-existent resources
