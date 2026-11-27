const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');
const { imageUrl } = require('../middleware/upload');

const CANCELLED_STATUSES = ['Dibatalkan', 'Batal', 'cancelled'];

async function getAllowedStatuses() {
  const [cols] = await db.query("SHOW COLUMNS FROM orders LIKE 'status'");
  const type = cols[0]?.Type || '';
  const matches = [...type.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  return matches.length ? matches : ['Baru', 'Diproses', 'Selesai', 'Dibatalkan'];
}

// GET /api/orders -> ambil semua pesanan beserta itemnya dan URL gambar produk
router.get('/', auth, async (req, res) => {
  const [orders] = await db.query(
    'SELECT * FROM orders ORDER BY created_at DESC, id DESC'
  );
  const [items] = await db.query(`
    SELECT oi.id, oi.order_id, oi.product_id, oi.product_name, oi.qty, oi.price, p.image
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
  `);

  const itemsByOrder = {};
  for (const it of items) {
    if (!itemsByOrder[it.order_id]) itemsByOrder[it.order_id] = [];
    itemsByOrder[it.order_id].push({
      ...it,
      image_url: it.image ? imageUrl(it.image) : null,
    });
  }

  res.json({
    data: orders.map((o) => ({
      ...o,
      items: itemsByOrder[o.id] || [],
    })),
  });
});

// POST /api/orders -> transaksi pembelian baru (kurangi stok & naikkan grafik)
router.post('/', async (req, res) => {
  const { customer_name, phone, customer_phone, address, payment, status, items } = req.body || {};

  if (!customer_name || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'Nama pembeli dan item wajib diisi' });
  }

  let total = 0;
  const resolvedItems = [];

  for (const item of items) {
    const productId = Number(item.product_id);
    const qty = Number(item.qty ?? item.quantity ?? 1);
    if (!productId || qty <= 0) {
      return res.status(400).json({ message: 'Item pesanan tidak valid' });
    }

    const [rows] = await db.query(
      'SELECT id, name, price, stock FROM products WHERE id = ?',
      [productId]
    );
    const product = rows[0];
    if (!product) {
      return res.status(404).json({ message: `Produk ID ${productId} tidak ditemukan` });
    }
    if (product.stock < qty) {
      return res.status(400).json({
        message: `Stok ${product.name} tidak mencukupi (sisa ${product.stock})`,
      });
    }

    const unitPrice = Number(product.price);
    total += unitPrice * qty;
    resolvedItems.push({
      product_id: product.id,
      product_name: product.name,
      qty,
      price: unitPrice,
    });
  }

  const allowedStatuses = await getAllowedStatuses();
  const orderStatus = allowedStatuses.includes(status) ? status : allowedStatuses[0];

  const [orderRes] = await db.query(
    'INSERT INTO orders (customer_name, phone, address, payment, status, total) VALUES (?, ?, ?, ?, ?, ?)',
    [
      customer_name.trim(),
      phone || customer_phone || null,
      address || null,
      payment || 'Transfer BCA',
      orderStatus,
      total,
    ]
  );
  const orderId = orderRes.insertId;

  for (const item of resolvedItems) {
    await db.query(
      'INSERT INTO order_items (order_id, product_id, product_name, qty, price) VALUES (?, ?, ?, ?, ?)',
      [orderId, item.product_id, item.product_name, item.qty, item.price]
    );
    if (!CANCELLED_STATUSES.includes(orderStatus)) {
      await db.query('UPDATE products SET stock = stock - ? WHERE id = ?', [
        item.qty,
        item.product_id,
      ]);
    }
  }

  res.status(201).json({ id: orderId, total, status: orderStatus });
});

// PATCH /api/orders/:id/status -> ubah status (kalau dibatalkan, grafik turun & stok balik)
router.patch('/:id/status', auth, async (req, res) => {
  const { status } = req.body || {};
  const allowedStatuses = await getAllowedStatuses();

  // Jika frontend mengirim 'cancelled', otomatis cocokkan ke opsi batal yang ada di ENUM
  let targetStatus = status;
  if (CANCELLED_STATUSES.includes(status) && !allowedStatuses.includes(status)) {
    targetStatus = allowedStatuses.find((s) => CANCELLED_STATUSES.includes(s));
  }

  if (!targetStatus || !allowedStatuses.includes(targetStatus)) {
    return res.status(400).json({
      message: `Status tidak valid. Pilihan: ${allowedStatuses.join(', ')}`,
    });
  }

  const [found] = await db.query('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  const old = found[0];
  if (!old) return res.status(404).json({ message: 'Pesanan tidak ditemukan' });

  if (old.status !== targetStatus) {
    const [items] = await db.query(
      'SELECT product_id, qty FROM order_items WHERE order_id = ?',
      [old.id]
    );
    const wasCancelled = CANCELLED_STATUSES.includes(old.status);
    const nowCancelled = CANCELLED_STATUSES.includes(targetStatus);

    if (!wasCancelled && nowCancelled) {
      for (const it of items) {
        if (it.product_id) {
          await db.query('UPDATE products SET stock = stock + ? WHERE id = ?', [
            it.qty,
            it.product_id,
          ]);
        }
      }
    } else if (wasCancelled && !nowCancelled) {
      for (const it of items) {
        if (it.product_id) {
          await db.query('UPDATE products SET stock = stock - ? WHERE id = ?', [
            it.qty,
            it.product_id,
          ]);
        }
      }
    }

    await db.query('UPDATE orders SET status = ? WHERE id = ?', [targetStatus, old.id]);
  }

  res.json({ id: old.id, status: targetStatus });
});

// DELETE /api/orders/:id -> hapus pesanan, kembalikan stok jika belum dibatalkan, & turunkan grafik
router.delete('/:id', auth, async (req, res) => {
  const [found] = await db.query('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  const order = found[0];
  if (!order) {
    return res.status(404).json({ message: 'Pesanan tidak ditemukan' });
  }

  const [items] = await db.query(
    'SELECT product_id, qty FROM order_items WHERE order_id = ?',
    [order.id]
  );

  // Kembalikan stok jika pesanan sebelumnya tidak berstatus batal
  if (!CANCELLED_STATUSES.includes(order.status)) {
    for (const it of items) {
      if (it.product_id) {
        await db.query('UPDATE products SET stock = stock + ? WHERE id = ?', [
          it.qty,
          it.product_id,
        ]);
      }
    }
  }

  await db.query('DELETE FROM order_items WHERE order_id = ?', [order.id]);
  await db.query('DELETE FROM orders WHERE id = ?', [order.id]);

  res.json({ message: 'Pesanan dihapus', id: order.id });
});

module.exports = router;