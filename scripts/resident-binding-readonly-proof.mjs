/**
 * Proves the preflight tool's read-only claim is enforced by SQLite, not by the
 * tool's own discipline. Opens the SAME evidence database with the same
 * `{ readOnly: true }` options the preflight uses and attempts a write; SQLite must
 * refuse it. This is the evidence quoted in the PR for "read-only preflight".
 *
 * Usage: node scripts/resident-binding-readonly-proof.mjs <sqlite>
 */
import { DatabaseSync } from 'node:sqlite'

const path = process.argv[2]
if (!path) {
  console.error('usage: node scripts/resident-binding-readonly-proof.mjs <sqlite>')
  process.exit(1)
}

const db = new DatabaseSync(path, { readOnly: true })
const attempts = [
  "INSERT INTO resident_community_assignments (user_id, community_id, created_at) VALUES ('x', 'y', 0)",
  "UPDATE resident_community_assignments SET community_id = community_id",
  "DELETE FROM resident_community_assignments",
  "INSERT INTO resident_community_bindings (id, user_id, community_id, status, confirmed_at, source, evidence_ref, created_at) VALUES ('x','y','z','confirmed',0,'resident_h5_confirmed','e',0)",
]
const results = []
for (const sql of attempts) {
  try {
    db.exec(sql)
    results.push({ sql, refused: false, error: null })
  } catch (error) {
    results.push({ sql, refused: true, error: `${error.code ?? ''} ${error.message}`.trim() })
  }
}
db.close()

const allRefused = results.every((row) => row.refused)
console.log(JSON.stringify({ databasePath: path, readOnly: true, allWritesRefused: allRefused, results }, null, 2))
if (!allRefused) process.exit(2)
