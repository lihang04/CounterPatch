import Database from "better-sqlite3";
import { scryptSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type Product = { id: number; name: string; description: string; price_cents: number };
export type User = { id: number; email: string; name: string };
export type Order = {
  id: number;
  user_id: number | null;
  email: string;
  total_cents: number;
  status: string;
};
export type OrderItem = {
  id: number;
  order_id: number;
  product_id: number;
  name: string;
  quantity: number;
  unit_price_cents: number;
};

// Fixture data. Mirrored in counterpatch.manifest.json so probes never guess.
const PRODUCTS: Omit<Product, "id">[] = [
  { name: "Ceramic Mug", description: "Stoneware, 350 ml.", price_cents: 1800 },
  { name: "Pour-over Kettle", description: "Gooseneck, 1 litre.", price_cents: 8000 },
  { name: "House Blend Beans", description: "Medium roast, 1 kg.", price_cents: 2450 },
];

const USERS = [
  { email: "alice@example.com", name: "Alice", password: "alice-password" },
  { email: "bob@example.com", name: "Bob", password: "bob-password" },
];

const SCHEMA = `
  CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    price_cents INTEGER NOT NULL
  );
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL
  );
  CREATE TABLE sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id)
  );
  CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    email TEXT NOT NULL,
    total_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'placed',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE order_items (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price_cents INTEGER NOT NULL
  );
`;

const TABLES = ["order_items", "orders", "sessions", "users", "products"];

export function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString("hex");
}

export function databasePath(): string {
  return process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "shop.sqlite");
}

export function openDatabase(): Database.Database {
  const file = databasePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  return db;
}

// Drops and recreates every table in one transaction, so a running server
// sharing the file sees either the old state or the fully seeded new one.
export function resetDatabase(db: Database.Database): void {
  db.transaction(() => {
    for (const table of TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.exec(SCHEMA);
    const insertProduct = db.prepare(
      "INSERT INTO products (name, description, price_cents) VALUES (?, ?, ?)",
    );
    for (const p of PRODUCTS) insertProduct.run(p.name, p.description, p.price_cents);
    const insertUser = db.prepare(
      "INSERT INTO users (email, name, password_salt, password_hash) VALUES (?, ?, ?, ?)",
    );
    for (const u of USERS) {
      // Fixed salt keeps the seeded database byte-for-byte reproducible.
      const salt = `fixture-salt-${u.email}`;
      insertUser.run(u.email, u.name, salt, hashPassword(u.password, salt));
    }
  })();
}

const globalForDb = globalThis as unknown as { shopDb?: Database.Database };

export function getDb(): Database.Database {
  if (!globalForDb.shopDb) {
    const db = openDatabase();
    const seeded = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'products'")
      .get();
    if (!seeded) resetDatabase(db);
    globalForDb.shopDb = db;
  }
  return globalForDb.shopDb;
}
