import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Deterministic product fixtures; every database is private to this test run. */
export function createFixtures(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const primary = path.join(directory, 'qa.db');
  const secondary = path.join(directory, 'second.db');
  for (const [file, marker] of [[primary, 'primary'], [secondary, 'secondary']]) {
    const db = new DatabaseSync(file);
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE markers (name TEXT NOT NULL);
        CREATE TABLE contacts (id INTEGER PRIMARY KEY, name TEXT NOT NULL,
          email TEXT UNIQUE, score REAL, note TEXT, active INTEGER DEFAULT 1, payload BLOB);
        INSERT INTO contacts VALUES
          (1,'Ada','ada@example.test',12.5,'first line'||char(10)||'second line',1,X'000102ff'),
          (2,'Caffè 東京','coffee@example.test',-1.25,'',0,X''),
          (3,'Null record',NULL,NULL,NULL,1,NULL);
        CREATE TABLE pages (id INTEGER PRIMARY KEY, category TEXT, value INTEGER);
        WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<251)
          INSERT INTO pages SELECT i, CASE WHEN i%2=0 THEN 'even' ELSE 'odd' END, i*10 FROM n;
        CREATE INDEX by_page_category ON pages(category,id);
        CREATE INDEX by_contact_name ON contacts(name);
        CREATE VIEW active_contacts AS SELECT id,name,score FROM contacts WHERE active=1;
        CREATE TABLE pairs (part TEXT, revision INTEGER, value TEXT,
          PRIMARY KEY(part,revision)) WITHOUT ROWID;
        INSERT INTO pairs VALUES ('left',1,'pair value'),('right',2,'second pair');
        CREATE TABLE computed (id INTEGER PRIMARY KEY, base INTEGER DEFAULT 7,
          doubled INTEGER GENERATED ALWAYS AS (base*2) STORED);
        INSERT INTO computed(id) VALUES(1);
        CREATE TABLE "space "" table" ("odd "" column" TEXT);
        INSERT INTO "space "" table" VALUES('quoted identifiers');
        CREATE TABLE exact_values (id INTEGER PRIMARY KEY, value INTEGER, text_value TEXT);
        INSERT INTO exact_values VALUES (1,9223372036854775807,'A'||char(0)||'B'),
          (2,-9223372036854775808,'é😀');
        CREATE TABLE import_target (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT, amount INTEGER DEFAULT 7);
        INSERT INTO import_target VALUES(1,'existing',NULL,7);
      `);
      db.prepare('INSERT INTO markers VALUES (?)').run(marker);
    } finally { db.close(); }
  }
  const files = {
    primary, secondary,
    csv: path.join(directory, 'import.csv'), json: path.join(directory, 'import.json'),
    conflict: path.join(directory, 'conflict.csv'), readonly: path.join(directory, 'readonly.db')
  };
  fs.writeFileSync(files.csv, 'id,name,note\r\n2,"Caffè 東京","line one\nline two"\r\n3,Empty,\r\n');
  fs.writeFileSync(files.json, JSON.stringify([{ source_id: 4, source_name: 'JSON row', source_note: null, ignored: 'skip' }]));
  fs.writeFileSync(files.conflict, 'id,name\n5,rollback row\n1,duplicate\n');
  fs.copyFileSync(primary, files.readonly);
  if (process.platform !== 'win32') fs.chmodSync(files.readonly, 0o444);
  return files;
}

export function readRows(file, sql) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(sql).all().map(row => ({ ...row })); }
  finally { db.close(); }
}
