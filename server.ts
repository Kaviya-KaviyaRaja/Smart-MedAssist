import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database("med_assist.db");

// Initialize Database
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    phone TEXT,
    caretaker_name TEXT,
    caretaker_phone TEXT,
    language TEXT DEFAULT 'Tamil'
  );

  CREATE TABLE IF NOT EXISTS medicines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    name TEXT NOT NULL,
    generic_name TEXT,
    disease_treated TEXT,
    dosage TEXT,
    expiry_date TEXT,
    stock_count INTEGER DEFAULT 0,
    schedule TEXT, -- JSON string of {morning: "08:00", afternoon: null, night: "20:00"}
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS consumption_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    medicine_id INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'taken',
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(medicine_id) REFERENCES medicines(id)
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    medicine_id INTEGER,
    scheduled_time TEXT NOT NULL, -- "HH:MM"
    status TEXT DEFAULT 'pending', -- 'pending', 'taken', 'missed'
    date TEXT NOT NULL, -- "YYYY-MM-DD"
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(medicine_id) REFERENCES medicines(id)
  );
`);

// Seed dummy data
const userCount = db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
if (userCount.count === 0) {
  db.prepare(`
    INSERT INTO users (name, email, password, phone, caretaker_name, caretaker_phone) 
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("Ramesh", "ramesh@example.com", "password123", "9876543210", "Suresh", "9123456789");
  
  db.prepare(`
    INSERT INTO medicines (user_id, name, generic_name, disease_treated, dosage, expiry_date, stock_count, schedule)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, "Paracetamol", "Acetaminophen", "Fever", "1 tablet after food", "2027-09-30", 10, JSON.stringify({morning: "08:00", afternoon: null, night: null}));
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));

  // Auth APIs
  app.post("/api/signup", (req, res) => {
    const { name, email, password, phone, caretaker_name, caretaker_phone } = req.body;
    try {
      const info = db.prepare(`
        INSERT INTO users (name, email, password, phone, caretaker_name, caretaker_phone) 
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(name, email, password, phone, caretaker_name, caretaker_phone);
      res.json({ id: info.lastInsertRowid, name, email });
    } catch (err) {
      res.status(400).json({ error: "Email already exists" });
    }
  });

  app.post("/api/login", (req, res) => {
    const { email, password } = req.body;
    const user = db.prepare("SELECT * FROM users WHERE email = ? AND password = ?").get(email, password);
    if (user) {
      res.json(user);
    } else {
      res.status(401).json({ error: "Invalid credentials" });
    }
  });

  // Medicine APIs
  app.get("/api/medicines/:userId", (req, res) => {
    const medicines = db.prepare("SELECT * FROM medicines WHERE user_id = ?").all(req.params.userId);
    res.json(medicines.map((m: any) => ({ ...m, schedule: JSON.parse(m.schedule || '{}') })));
  });

  app.post("/api/medicines", (req, res) => {
    const { user_id, name, generic_name, disease_treated, dosage, expiry_date, stock_count, schedule } = req.body;
    const info = db.prepare(`
      INSERT INTO medicines (user_id, name, generic_name, disease_treated, dosage, expiry_date, stock_count, schedule)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(user_id, name, generic_name, disease_treated, dosage, expiry_date, stock_count, JSON.stringify(schedule));
    res.json({ id: info.lastInsertRowid });
  });

  app.post("/api/take-medicine", (req, res) => {
    const { user_id, medicine_id } = req.body;
    db.transaction(() => {
      db.prepare("UPDATE medicines SET stock_count = stock_count - 1 WHERE id = ?").run(medicine_id);
      db.prepare("INSERT INTO consumption_history (user_id, medicine_id) VALUES (?, ?)").run(user_id, medicine_id);
    })();
    res.json({ success: true });
  });

  app.delete("/api/medicines/:id", (req, res) => {
    const medId = req.params.id;
    try {
      db.transaction(() => {
        // Delete related records first
        db.prepare("DELETE FROM reminders WHERE medicine_id = ?").run(medId);
        db.prepare("DELETE FROM consumption_history WHERE medicine_id = ?").run(medId);
        // Then delete the medicine
        db.prepare("DELETE FROM medicines WHERE id = ?").run(medId);
      })();
      res.json({ success: true });
    } catch (err) {
      console.error("Delete error:", err);
      res.status(500).json({ error: "Failed to delete medicine" });
    }
  });

  // Reminder APIs
  app.get("/api/reminders/:userId", (req, res) => {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const reminders = db.prepare(`
      SELECT r.*, m.name as medicine_name, m.dosage 
      FROM reminders r 
      JOIN medicines m ON r.medicine_id = m.id 
      WHERE r.user_id = ? AND r.date = ?
    `).all(req.params.userId, date);
    res.json(reminders);
  });

  app.post("/api/reminders/check", (req, res) => {
    const { user_id } = req.body;
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // Generate reminders for the next 7 days
    const medicines = db.prepare("SELECT * FROM medicines WHERE user_id = ?").all(user_id);
    
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().split('T')[0];

      medicines.forEach((m: any) => {
        const schedule = JSON.parse(m.schedule || '{}');
        Object.entries(schedule).forEach(([period, time]) => {
          if (time) {
            const exists = db.prepare("SELECT id FROM reminders WHERE medicine_id = ? AND date = ? AND scheduled_time = ?")
              .get(m.id, dateStr, time);
            if (!exists) {
              db.prepare("INSERT INTO reminders (user_id, medicine_id, scheduled_time, date) VALUES (?, ?, ?, ?)")
                .run(user_id, m.id, time, dateStr);
            }
          }
        });
      });
    }

    // Mark missed doses for today
    const today = new Date().toISOString().split('T')[0];
    db.prepare(`
      UPDATE reminders 
      SET status = 'missed' 
      WHERE user_id = ? AND date = ? AND status = 'pending' AND scheduled_time < ?
    `).run(user_id, today, currentTime);

    res.json({ success: true });
  });

  app.post("/api/reminders/confirm", (req, res) => {
    const { reminder_id, user_id, medicine_id } = req.body;
    db.transaction(() => {
      db.prepare("UPDATE reminders SET status = 'taken' WHERE id = ?").run(reminder_id);
      db.prepare("UPDATE medicines SET stock_count = stock_count - 1 WHERE id = ?").run(medicine_id);
      db.prepare("INSERT INTO consumption_history (user_id, medicine_id) VALUES (?, ?)").run(user_id, medicine_id);
    })();
    res.json({ success: true });
  });

  app.get("/api/history/:userId", (req, res) => {
    const history = db.prepare(`
      SELECT h.*, m.name as medicine_name 
      FROM consumption_history h 
      JOIN medicines m ON h.medicine_id = m.id 
      WHERE h.user_id = ? 
      ORDER BY h.timestamp DESC 
      LIMIT 20
    `).all(req.params.userId);
    res.json(history);
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
