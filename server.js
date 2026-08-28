/**
 * سيرفر نظام الحسابات — يستخدم قاعدة بيانات SQL حقيقية (SQLite)
 * عن طريق موديول node:sqlite المدمج في Node.js — بدون أي مكتبات خارجية.
 *
 * يتطلب Node.js v22.5.0 أو أحدث (node:sqlite لسه experimental في Node،
 * فهيظهر تحذير بسيط في الترمينال عند التشغيل، ده طبيعي ومش خطأ).
 *
 * البيانات بتتخزن في ملف SQLite حقيقي: data.db (جنب هذا الملف)
 * وبيتحول تلقائيًا من نظام الملف القديم (data.json) لو موجود.
 *
 * API (نفسه زي الأول، عشان الواجهة الأمامية متتغيرش):
 *   GET  /api/data   -> يرجع كل بيانات الشركة الحالية (JSON) بعد قراءتها من جداول SQL
 *   PUT  /api/data    -> يستقبل كل البيانات (JSON) ويعيد كتابتها في جداول SQL (استبدال كامل داخل معاملة واحدة)
 *
 * التشغيل: node server.js   (أو: npm start)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "data.db");
const OLD_JSON_FILE = path.join(__dirname, "data.json");
const PUBLIC_DIR = path.join(__dirname, "public");

const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA foreign_keys = ON;");

/* ---------------- تعريف الجداول (SQL schema) ---------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS company (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT, activity TEXT, phone TEXT, address TEXT, taxId TEXT, currency TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT, password TEXT, fullName TEXT, role TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, code TEXT, name TEXT, nameEn TEXT, type TEXT,
  parentId TEXT, balance REAL DEFAULT 0, editable INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS banks (
  id TEXT PRIMARY KEY, bankName TEXT, accountNumber TEXT, iban TEXT,
  branch TEXT, notes TEXT, balance REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, sku TEXT, name TEXT, unit TEXT,
  costPrice REAL DEFAULT 0, salePrice REAL DEFAULT 0, openingStock REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, name TEXT, phone TEXT, email TEXT, balance REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY, name TEXT, phone TEXT, email TEXT, balance REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY, name TEXT, position TEXT, salary REAL DEFAULT 0,
  phone TEXT, hireDate TEXT, department TEXT, managerId TEXT
);

CREATE TABLE IF NOT EXISTS sales_invoices (
  id TEXT PRIMARY KEY, number TEXT, customerId TEXT, date TEXT, status TEXT, bankId TEXT
);
CREATE TABLE IF NOT EXISTS sales_invoice_items (
  id TEXT PRIMARY KEY, invoiceId TEXT, productId TEXT, desc TEXT, qty REAL, price REAL,
  FOREIGN KEY (invoiceId) REFERENCES sales_invoices(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS purchase_invoices (
  id TEXT PRIMARY KEY, number TEXT, supplierId TEXT, date TEXT, status TEXT, bankId TEXT, accountId TEXT
);
CREATE TABLE IF NOT EXISTS purchase_invoice_items (
  id TEXT PRIMARY KEY, invoiceId TEXT, productId TEXT, desc TEXT, qty REAL, price REAL,
  FOREIGN KEY (invoiceId) REFERENCES purchase_invoices(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY, date TEXT, memo TEXT, currency TEXT, exchangeRate REAL
);
CREATE TABLE IF NOT EXISTS transaction_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT, txId TEXT, accountId TEXT, desc TEXT,
  debit REAL DEFAULT 0, credit REAL DEFAULT 0,
  FOREIGN KEY (txId) REFERENCES transactions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS attendance (
  id TEXT PRIMARY KEY, employeeId TEXT, date TEXT, checkIn TEXT, checkOut TEXT, status TEXT
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id TEXT PRIMARY KEY, month TEXT, date TEXT, total REAL DEFAULT 0, status TEXT
);
CREATE TABLE IF NOT EXISTS payroll_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, runId TEXT, employeeId TEXT,
  base REAL DEFAULT 0, bonus REAL DEFAULT 0, deduction REAL DEFAULT 0, net REAL DEFAULT 0,
  FOREIGN KEY (runId) REFERENCES payroll_runs(id) ON DELETE CASCADE
);
`);

/* ---------------- شجرة الحسابات الافتراضية (تُزرع مرة واحدة فقط) ---------------- */
const DEFAULT_ACCOUNTS = [
  ["a1", "1", "الأصول", "Assets", "root", null, 0, 0],
  ["a1-1", "1-1", "الخزينة (نقدية)", "Cash on Hand", "asset", "a1", 0, 1],
  ["a1-2", "1-2", "البنك", "Bank", "asset", "a1", 0, 1],
  ["a1-3", "1-3", "عملاء (ذمم مدينة)", "Accounts Receivable", "asset", "a1", 0, 0],
  ["a1-4", "1-4", "أجهزة ومعدات", "Equipment", "asset", "a1", 0, 1],
  ["a2", "2", "الخصوم", "Liabilities", "root", null, 0, 0],
  ["a2-1", "2-1", "موردون (ذمم دائنة)", "Accounts Payable", "liability", "a2", 0, 0],
  ["a2-2", "2-2", "قروض قصيرة الأجل", "Short-term Loans", "liability", "a2", 0, 1],
  ["a3", "3", "حقوق الملكية", "Equity", "root", null, 0, 0],
  ["a3-1", "3-1", "رأس المال", "Capital", "equity", "a3", 0, 1],
  ["a3-2", "3-2", "أرباح مرحّلة", "Retained Earnings", "equity", "a3", 0, 1],
  ["a4", "4", "الإيرادات", "Revenue", "root", null, 0, 0],
  ["a4-1", "4-1", "إيراد المبيعات / الخدمات", "Sales / Service Revenue", "revenue", "a4", 0, 0],
  ["a4-2", "4-2", "إيرادات أخرى", "Other Revenue", "revenue", "a4", 0, 0],
  ["a5", "5", "المصروفات", "Expenses", "root", null, 0, 0],
  ["a5-1", "5-1", "رواتب وأجور", "Salaries & Wages", "expense", "a5", 0, 0],
  ["a5-2", "5-2", "إيجار", "Rent", "expense", "a5", 0, 0],
  ["a5-3", "5-3", "اشتراكات وأدوات", "Subscriptions & Tools", "expense", "a5", 0, 0],
  ["a5-4", "5-4", "تسويق وإعلان", "Marketing", "expense", "a5", 0, 0],
  ["a5-5", "5-5", "مصروفات متنوعة", "Miscellaneous Expenses", "expense", "a5", 0, 0],
];

function seedDefaultAccountsIfEmpty() {
  const count = db.prepare("SELECT COUNT(*) AS c FROM accounts").get().c;
  if (count > 0) return;
  const stmt = db.prepare(
    "INSERT INTO accounts (id, code, name, nameEn, type, parentId, balance, editable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  db.exec("BEGIN");
  try {
    for (const row of DEFAULT_ACCOUNTS) stmt.run(...row);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/* ---------------- ترحيل تلقائي من data.json القديم (لو موجود ولسه معملوش ترحيل) ---------------- */
function migrateFromOldJsonIfNeeded() {
  const hasCompany = db.prepare("SELECT COUNT(*) AS c FROM company").get().c > 0;
  const hasUsers = db.prepare("SELECT COUNT(*) AS c FROM users").get().c > 0;
  if ((hasCompany || hasUsers) || !fs.existsSync(OLD_JSON_FILE)) return;
  try {
    const old = JSON.parse(fs.readFileSync(OLD_JSON_FILE, "utf8"));
    console.log("لقيت data.json قديم — جارِ ترحيل البيانات لقاعدة SQL...");
    writeData(old);
    fs.renameSync(OLD_JSON_FILE, OLD_JSON_FILE + ".migrated");
    console.log("تم الترحيل بنجاح. الملف القديم اتسمى data.json.migrated للأمان.");
  } catch (err) {
    console.error("تعذّر ترحيل data.json القديم:", err.message);
  }
}

seedDefaultAccountsIfEmpty();
migrateFromOldJsonIfNeeded();

/* ---------------- قراءة كل البيانات من SQL وتجميعها بنفس شكل JSON اللي الواجهة متوقعاه ---------------- */
function all(sql, ...params) { return db.prepare(sql).all(...params); }
function get(sql, ...params) { return db.prepare(sql).get(...params); }

function readData() {
  const companyRow = get("SELECT * FROM company WHERE id = 1");
  const company = companyRow
    ? { name: companyRow.name, activity: companyRow.activity, phone: companyRow.phone, address: companyRow.address, taxId: companyRow.taxId, currency: companyRow.currency }
    : null;

  const users = all("SELECT id, username, password, fullName, role FROM users");

  const accounts = all("SELECT * FROM accounts").map(a => ({
    id: a.id, code: a.code, name: a.name, nameEn: a.nameEn, type: a.type,
    parentId: a.parentId, balance: a.balance, editable: !!a.editable,
  }));

  const banks = all("SELECT * FROM banks");
  const products = all("SELECT * FROM products");
  const customers = all("SELECT * FROM customers");
  const suppliers = all("SELECT * FROM suppliers");
  const employees = all("SELECT * FROM employees");

  const salesItems = all("SELECT * FROM sales_invoice_items");
  const salesInvoices = all("SELECT * FROM sales_invoices").map(inv => ({
    ...inv,
    bankId: inv.bankId || undefined,
    items: salesItems.filter(it => it.invoiceId === inv.id).map(it => ({ id: it.id, productId: it.productId || undefined, desc: it.desc, qty: it.qty, price: it.price })),
  }));

  const purchaseItems = all("SELECT * FROM purchase_invoice_items");
  const purchaseInvoices = all("SELECT * FROM purchase_invoices").map(inv => ({
    ...inv,
    bankId: inv.bankId || undefined,
    items: purchaseItems.filter(it => it.invoiceId === inv.id).map(it => ({ id: it.id, productId: it.productId || undefined, desc: it.desc, qty: it.qty, price: it.price })),
  }));

  const txLines = all("SELECT * FROM transaction_lines");
  const transactions = all("SELECT * FROM transactions").map(tx => ({
    id: tx.id, date: tx.date, memo: tx.memo,
    currency: tx.currency || undefined, exchangeRate: tx.exchangeRate || undefined,
    lines: txLines.filter(l => l.txId === tx.id).map(l => ({ accountId: l.accountId, desc: l.desc || "", debit: l.debit, credit: l.credit })),
  }));

  const attendance = all("SELECT * FROM attendance");

  const payItems = all("SELECT * FROM payroll_items");
  const payrollRuns = all("SELECT * FROM payroll_runs").map(run => ({
    id: run.id, month: run.month, date: run.date, total: run.total, status: run.status,
    items: payItems.filter(it => it.runId === run.id).map(it => ({ employeeId: it.employeeId, base: it.base, bonus: it.bonus, deduction: it.deduction, net: it.net })),
  }));

  return { company, users, accounts, banks, products, customers, suppliers, employees, salesInvoices, purchaseInvoices, transactions, attendance, payrollRuns };
}

/* ---------------- كتابة كل البيانات: استبدال كامل داخل معاملة SQL واحدة ---------------- */
function writeData(obj) {
  db.exec("BEGIN");
  try {
    // امسح كل الجداول (الترتيب مش مهم مع ON DELETE CASCADE، لكن بنمسح كله بالضبط)
    [
      "sales_invoice_items", "sales_invoices", "purchase_invoice_items", "purchase_invoices",
      "transaction_lines", "transactions", "attendance", "payroll_items", "payroll_runs",
      "company", "users", "accounts", "banks", "products", "customers", "suppliers", "employees",
    ].forEach(t => db.exec(`DELETE FROM ${t}`));

    if (obj.company) {
      db.prepare(
        "INSERT INTO company (id, name, activity, phone, address, taxId, currency) VALUES (1, ?, ?, ?, ?, ?, ?)"
      ).run(obj.company.name || "", obj.company.activity || "", obj.company.phone || "", obj.company.address || "", obj.company.taxId || "", obj.company.currency || "");
    }

    const insUser = db.prepare("INSERT INTO users (id, username, password, fullName, role) VALUES (?, ?, ?, ?, ?)");
    (obj.users || []).forEach(u => insUser.run(u.id, u.username, u.password, u.fullName, u.role));

    const insAcc = db.prepare("INSERT INTO accounts (id, code, name, nameEn, type, parentId, balance, editable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    (obj.accounts || []).forEach(a => insAcc.run(a.id, a.code, a.name, a.nameEn || "", a.type, a.parentId, Number(a.balance) || 0, a.editable ? 1 : 0));

    const insBank = db.prepare("INSERT INTO banks (id, bankName, accountNumber, iban, branch, notes, balance) VALUES (?, ?, ?, ?, ?, ?, ?)");
    (obj.banks || []).forEach(b => insBank.run(b.id, b.bankName || "", b.accountNumber || "", b.iban || "", b.branch || "", b.notes || "", Number(b.balance) || 0));

    const insProd = db.prepare("INSERT INTO products (id, sku, name, unit, costPrice, salePrice, openingStock) VALUES (?, ?, ?, ?, ?, ?, ?)");
    (obj.products || []).forEach(p => insProd.run(p.id, p.sku || "", p.name || "", p.unit || "", Number(p.costPrice) || 0, Number(p.salePrice) || 0, Number(p.openingStock) || 0));

    const insCust = db.prepare("INSERT INTO customers (id, name, phone, email, balance) VALUES (?, ?, ?, ?, ?)");
    (obj.customers || []).forEach(c => insCust.run(c.id, c.name || "", c.phone || "", c.email || "", Number(c.balance) || 0));

    const insSup = db.prepare("INSERT INTO suppliers (id, name, phone, email, balance) VALUES (?, ?, ?, ?, ?)");
    (obj.suppliers || []).forEach(s => insSup.run(s.id, s.name || "", s.phone || "", s.email || "", Number(s.balance) || 0));

    const insEmp = db.prepare("INSERT INTO employees (id, name, position, salary, phone, hireDate, department, managerId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    (obj.employees || []).forEach(e => insEmp.run(e.id, e.name || "", e.position || "", Number(e.salary) || 0, e.phone || "", e.hireDate || "", e.department || "", e.managerId || null));

    const insSI = db.prepare("INSERT INTO sales_invoices (id, number, customerId, date, status, bankId) VALUES (?, ?, ?, ?, ?, ?)");
    const insSIItem = db.prepare("INSERT INTO sales_invoice_items (id, invoiceId, productId, desc, qty, price) VALUES (?, ?, ?, ?, ?, ?)");
    (obj.salesInvoices || []).forEach(inv => {
      insSI.run(inv.id, inv.number, inv.customerId, inv.date, inv.status, inv.bankId || null);
      (inv.items || []).forEach(it => insSIItem.run(it.id, inv.id, it.productId || null, it.desc || "", Number(it.qty) || 0, Number(it.price) || 0));
    });

    const insPI = db.prepare("INSERT INTO purchase_invoices (id, number, supplierId, date, status, bankId, accountId) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const insPIItem = db.prepare("INSERT INTO purchase_invoice_items (id, invoiceId, productId, desc, qty, price) VALUES (?, ?, ?, ?, ?, ?)");
    (obj.purchaseInvoices || []).forEach(inv => {
      insPI.run(inv.id, inv.number, inv.supplierId, inv.date, inv.status, inv.bankId || null, inv.accountId || null);
      (inv.items || []).forEach(it => insPIItem.run(it.id, inv.id, it.productId || null, it.desc || "", Number(it.qty) || 0, Number(it.price) || 0));
    });

    const insTx = db.prepare("INSERT INTO transactions (id, date, memo, currency, exchangeRate) VALUES (?, ?, ?, ?, ?)");
    const insTxLine = db.prepare("INSERT INTO transaction_lines (txId, accountId, desc, debit, credit) VALUES (?, ?, ?, ?, ?)");
    (obj.transactions || []).forEach(tx => {
      insTx.run(tx.id, tx.date, tx.memo, tx.currency || null, tx.exchangeRate != null ? Number(tx.exchangeRate) : null);
      (tx.lines || []).forEach(l => insTxLine.run(tx.id, l.accountId, l.desc || "", Number(l.debit) || 0, Number(l.credit) || 0));
    });

    const insAtt = db.prepare("INSERT INTO attendance (id, employeeId, date, checkIn, checkOut, status) VALUES (?, ?, ?, ?, ?, ?)");
    (obj.attendance || []).forEach(a => insAtt.run(a.id, a.employeeId, a.date, a.checkIn || "", a.checkOut || "", a.status || ""));

    const insRun = db.prepare("INSERT INTO payroll_runs (id, month, date, total, status) VALUES (?, ?, ?, ?, ?)");
    const insRunItem = db.prepare("INSERT INTO payroll_items (runId, employeeId, base, bonus, deduction, net) VALUES (?, ?, ?, ?, ?, ?)");
    (obj.payrollRuns || []).forEach(run => {
      insRun.run(run.id, run.month, run.date, Number(run.total) || 0, run.status || "");
      (run.items || []).forEach(it => insRunItem.run(run.id, it.employeeId, Number(it.base) || 0, Number(it.bonus) || 0, Number(it.deduction) || 0, Number(it.net) || 0));
    });

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/* ---------------- تقديم الملفات الثابتة (الواجهة) ---------------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("الصفحة غير موجودة");
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(content);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 20 * 1024 * 1024) req.destroy();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/* ---------------- السيرفر ---------------- */
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.url.startsWith("/api/data") && req.method === "GET") {
    try {
      const data = readData();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (req.url.startsWith("/api/data") && req.method === "PUT") {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      writeData(parsed);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  if (req.url.startsWith("/api/")) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "not found" }));
  }

  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`نظام الحسابات شغّال على: http://localhost:${PORT}`);
  console.log(`قاعدة بيانات SQL: ${DB_FILE}`);
});
