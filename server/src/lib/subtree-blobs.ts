import { query } from "../db/pool.js";

/** Collect before cascading node deletion: versions disappear with their nodes. */
export async function subtreeBlobRefs(nodeId: string): Promise<Set<string>> {
  const rows = await query<{ content_ref: string | null }>(
    `WITH RECURSIVE subtree AS (
       SELECT id, content_ref FROM nodes WHERE id = $1
       UNION
       SELECT n.id, n.content_ref FROM nodes n JOIN subtree s ON n.parent_id = s.id
     )
     SELECT content_ref FROM subtree
     UNION
     SELECT v.content_ref FROM node_versions v JOIN subtree s ON v.node_id = s.id`,
    [nodeId],
  );
  return new Set(rows.map((r) => r.content_ref).filter((ref): ref is string => !!ref));
}
