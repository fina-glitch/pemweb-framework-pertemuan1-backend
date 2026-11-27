const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/gi,
  /system\s*:/gi,
  /assistant\s*:/gi,
  /developer\s*:/gi,
  /you\s+are\s+now\s+a/gi,
  /reveal\s+(your\s+)?(system\s+prompt|api\s*key|secret|env)/gi,
  /```[\s\S]*?```/g,
];

function sanitizeText(input = "") {
  let clean = String(input);
  for (const pattern of INJECTION_PATTERNS) {
    clean = clean.replace(pattern, "[filtered]");
  }
  // Samarkan pola nomor HP atau email jika tidak sengaja terbawa
  clean = clean.replace(/\b\d{9,15}\b/g, "[REDACTED_PHONE]");
  clean = clean.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]");
  return clean.trim().slice(0, 500);
}

function anonymizeSnapshot({ products = [], orders = [], focusNote = "" }) {
  // Jangan sertakan nama pelanggan, no HP, alamat, atau data sensitif user
  const safeProducts = products.map((p) => ({
    id: p.id,
    name: sanitizeText(p.name),
    category: sanitizeText(p.category_name || p.category || "Charm"),
    stock: Number(p.stock ?? 0),
    price: Number(p.price ?? 0),
  }));

  const safeOrders = orders.map((o) => ({
    order_code: `ORD-${o.id}`,
    status: sanitizeText(o.status || "Baru"),
    total: Number(o.total ?? 0),
    items: Array.isArray(o.items)
      ? o.items.map((it) => ({
          product_name: sanitizeText(it.product_name || it.name || "Item"),
          qty: Number(it.qty ?? 1),
        }))
      : [],
  }));

  return {
    products: safeProducts,
    orders: safeOrders,
    admin_focus_note: sanitizeText(focusNote),
  };
}

module.exports = {
  sanitizeText,
  anonymizeSnapshot,
};