const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("C:/Users/pocot/AppData/Local/T9EditorLIT/deploy/ledger.db", {
  readOnly: true,
});
const rows = db
  .prepare(
    "SELECT id,status,phase,agent,task,created_ms FROM work_orders WHERE status IN ('queued','active') ORDER BY created_ms ASC",
  )
  .all();
for (const r of rows) {
  console.log(r.id, "|", r.status, "|", r.phase, "|", r.agent, "|", r.task);
}
