/** SQL predicate for queries with share_links `sl` and nodes `n` aliases. */
export const LIVE_SHARE_POLICY = `
  EXISTS (SELECT 1 FROM users creator
    JOIN memberships membership ON membership.user_id = creator.id
      AND membership.org_id = n.org_id AND membership.status = 'active'
    WHERE creator.id = sl.created_by AND creator.status = 'active')
  AND NOT EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_id, trashed_at FROM nodes WHERE id = n.id
      UNION
      SELECT parent.id, parent.parent_id, parent.trashed_at
        FROM nodes parent JOIN ancestors child ON parent.id = child.parent_id
    )
    SELECT 1 FROM ancestors WHERE trashed_at IS NOT NULL
  )`;
