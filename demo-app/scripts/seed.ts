import { databasePath, openDatabase, resetDatabase } from "../lib/db";

const db = openDatabase();
resetDatabase(db);
db.close();
console.log(`Seeded ${databasePath()}`);
