/** Test adapter: gives Node's built-in SQLite the small surface the Durable Object SQL API has (`exec(query, ...bindings)` returning a
 * cursor with toArray()/one()). The Gateway runs the SAME SQL in both places. Also counts statements to prove cheap read paths. */
import {DatabaseSync} from 'node:sqlite';

export function nodeSql(path = ':memory:') {
  const db = new DatabaseSync(path);
  const log = [];
  return {
    db, log,
    exec(query, ...bindings) {
      log.push(query.trim().split(/\s+/).slice(0, 2).join(' ').toUpperCase());
      const statement = db.prepare(query);
      if (/^\s*(SELECT|WITH)\b/i.test(query) || /\bRETURNING\b/i.test(query)) {
        const rows = statement.all(...bindings).map(r => ({...r}));
        return {toArray: () => rows, one: () => rows[0]};
      }
      statement.run(...bindings);
      return {toArray: () => [], one: () => undefined};
    },
    close() { db.close(); }
  };
}
