/**
 * سيرفر بسيط لنظام الحسابات — بدون أي مكتبات خارجية (Node.js فقط)
 * - يخزّن كل بيانات الشركة في ملف data.json بجانب هذا الملف
 * - يوفّر API بسيط:
 *     GET  /api/data   -> يرجع كل البيانات الحالية (JSON)
 *     PUT  /api/data   -> يستبدل كل البيانات بالمرسلة في الطلب (JSON)
 * - يقدّم ملفات الواجهة (public/) كموقع ويب عادي
 *
 * التشغيل:  node server.js   (أو: npm start)
 * الافتراضي: http://localhost:3000
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");
const PUBLIC_DIR = path.join(__dirname, "public");

/* ---------------- بيانات افتراضية (شركة فاضية جاهزة لإدخال بيانات حقيقية) ---------------- */
function defaultData() {
  const accounts = [
    { id: "a1", code: "1", name: "الأصول", type: "root", parentId: null },
    { id: "a1-1", code: "1-1", name: "الخزينة (نقدية)", type: "asset", parentId: "a1", balance: 0, editable: true },
    { id: "a1-2", code: "1-2", name: "البنك", type: "asset", parentId: "a1", balance: 0, editable: true },
    { id: "a1-3", code: "1-3", name: "عملاء (ذمم مدينة)", type: "asset", parentId: "a1", balance: 0, editable: false },
    { id: "a1-4", code: "1-4", name: "أجهزة ومعدات", type: "asset", parentId: "a1", balance: 0, editable: true },
    { id: "a2", code: "2", name: "الخصوم", type: "root", parentId: null },
    { id: "a2-1", code: "2-1", name: "موردون (ذمم دائنة)", type: "liability", parentId: "a2", balance: 0, editable: false },
    { id: "a2-2", code: "2-2", name: "قروض قصيرة الأجل", type: "liability", parentId: "a2", balance: 0, editable: true },
    { id: "a3", code: "3", name: "حقوق الملكية", type: "root", parentId: null },
    { id: "a3-1", code: "3-1", name: "رأس المال", type: "equity", parentId: "a3", balance: 0, editable: true },
    { id: "a3-2", code: "3-2", name: "أرباح مرحّلة", type: "equity", parentId: "a3", balance: 0, editable: true },
    { id: "a4", code: "4", name: "الإيرادات", type: "root", parentId: null },
    { id: "a4-1", code: "4-1", name: "إيراد المبيعات / الخدمات", type: "revenue", parentId: "a4", balance: 0, editable: false },
    { id: "a4-2", code: "4-2", name: "إيرادات أخرى", type: "revenue", parentId: "a4", balance: 0, editable: false },
    { id: "a5", code: "5", name: "المصروفات", type: "root", parentId: null },
    { id: "a5-1", code: "5-1", name: "رواتب وأجور", type: "expense", parentId: "a5", balance: 0, editable: false },
    { id: "a5-2", code: "5-2", name: "إيجار", type: "expense", parentId: "a5", balance: 0, editable: false },
    { id: "a5-3", code: "5-3", name: "اشتراكات وأدوات", type: "expense", parentId: "a5", balance: 0, editable: false },
    { id: "a5-4", code: "5-4", name: "تسويق وإعلان", type: "expense", parentId: "a5", balance: 0, editable: false },
    { id: "a5-5", code: "5-5", name: "مصروفات متنوعة", type: "expense", parentId: "a5", balance: 0, editable: false },
  ];
  return {
    company: null,
    accounts,
    customers: [],
    suppliers: [],
    employees: [],
    salesInvoices: [],
    purchaseInvoices: [],
    transactions: [],
  };
}

/* ---------------- تخزين البيانات في ملف JSON على القرص ---------------- */
function readData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const fresh = defaultData();
      fs.writeFileSync(DATA_FILE, JSON.stringify(fresh, null, 2), "utf8");
      return fresh;
    }
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("خطأ في قراءة data.json:", err.message);
    return defaultData();
  }
}

let writeQueue = Promise.resolve();
function writeData(obj) {
  // طابور بسيط لمنع تعارض الكتابة لو جالك أكتر من طلب في نفس اللحظة
  writeQueue = writeQueue.then(
    () =>
      new Promise((resolve, reject) => {
        fs.writeFile(DATA_FILE, JSON.stringify(obj, null, 2), "utf8", (err) => {
          if (err) reject(err);
          else resolve();
        });
      })
  );
  return writeQueue;
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

  // منع الخروج من مجلد public
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

/* ---------------- قراءة جسم الطلب ---------------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 20 * 1024 * 1024) req.destroy(); // حد أقصى 20MB حماية بسيطة
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
    const data = readData();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify(data));
  }

  if (req.url.startsWith("/api/data") && req.method === "PUT") {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      await writeData(parsed);
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
  console.log(`بيانات الشركة متخزنة في: ${DATA_FILE}`);
});
