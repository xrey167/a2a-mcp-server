/**
 * CRUD routes for /items resource.
 */

import type { FastifyInstance } from "fastify";
import { listItems, getItem, createItem, updateItem, deleteItem } from "../db/schema.js";

export async function itemRoutes(app: FastifyInstance) {
  // GET /items — list all items
  app.get("/items", async (request) => {
    const { limit = 50, offset = 0 } = request.query as { limit?: number; offset?: number };
    const items = listItems(Number(limit), Number(offset));
    return { items, count: items.length };
  });

  // GET /items/:id — get single item
  app.get<{ Params: { id: string } }>("/items/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (isNaN(id)) { reply.code(400); return { error: "Invalid id" }; }

    const item = getItem(id);
    if (!item) { reply.code(404); return { error: "Item not found" }; }
    return item;
  });

  // POST /items — create item
  app.post<{ Body: { name: string; description?: string } }>("/items", async (request, reply) => {
    const { name, description } = request.body ?? {};
    if (!name || typeof name !== "string") {
      reply.code(400);
      return { error: "name is required and must be a string" };
    }

    const item = createItem(name.trim(), (description ?? "").trim());
    reply.code(201);
    return item;
  });

  // PUT /items/:id — update item
  app.put<{ Params: { id: string }; Body: { name?: string; description?: string } }>(
    "/items/:id",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (isNaN(id)) { reply.code(400); return { error: "Invalid id" }; }

      const item = updateItem(id, request.body ?? {});
      if (!item) { reply.code(404); return { error: "Item not found" }; }
      return item;
    },
  );

  // DELETE /items/:id — delete item
  app.delete<{ Params: { id: string } }>("/items/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (isNaN(id)) { reply.code(400); return { error: "Invalid id" }; }

    const deleted = deleteItem(id);
    if (!deleted) { reply.code(404); return { error: "Item not found" }; }
    return { deleted: true };
  });
}
