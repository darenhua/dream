import { Hono } from "hono";
import { listEvents } from "../../services/events";

export const eventRoutes = new Hono();

eventRoutes.get("/", c => {
  const { entity, entityId, limit } = c.req.query();
  return c.json(
    listEvents({
      entityType: entity || undefined,
      entityId: entityId || undefined,
      limit: limit ? Number(limit) : undefined,
    }),
  );
});
