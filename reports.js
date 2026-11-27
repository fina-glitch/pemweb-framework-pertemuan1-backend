const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

const HARI = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const BULAN_FULL = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

router.get('/summary', auth, async (req, res) => {
  // 1. Laporan harian: 7 hari terakhir
  const [dailyRows] = await db.query(`
    SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS tgl,
           COUNT(*) AS total_orders,
           COALESCE(SUM(total), 0) AS total_revenue
    FROM orders
    WHERE status NOT IN ('Dibatalkan', 'Batal', 'cancelled')
      AND created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
    GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d')
  `);
  const dailyMap = Object.fromEntries(dailyRows.map((r) => [r.tgl, r]));

  const dailyData = [];
  const revenue7Days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = localDateKey(d);
    const row = dailyMap[key];
    dailyData.push({
      label: HARI[d.getDay()],
      value: row ? Number(row.total_orders) : 0,
    });
    revenue7Days.push({
      label: HARI[d.getDay()],
      value: row ? Math.round(Number(row.total_revenue) / 1000) : 0,
    });
  }

  // 2. Laporan bulanan: 6 bulan terakhir (Rp juta)
  const [monthlyRows] = await db.query(`
    SELECT DATE_FORMAT(created_at, '%Y-%m') AS ym, COALESCE(SUM(total), 0) AS total
    FROM orders
    WHERE status NOT IN ('Dibatalkan', 'Batal', 'cancelled')
      AND created_at >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 5 MONTH), '%Y-%m-01')
    GROUP BY DATE_FORMAT(created_at, '%Y-%m')
  `);
  const monthlyMap = Object.fromEntries(monthlyRows.map((r) => [r.ym, Number(r.total)]));

  const monthlyData = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    monthlyData.push({
      label: BULAN[d.getMonth()],
      value: Number(((monthlyMap[ym] || 0) / 1_000_000).toFixed(2)),
    });
  }

  // 3. Laporan per kategori komponen (%)
  const [catRows] = await db.query(`
    SELECT COALESCE(c.name, 'Lainnya') AS name, COALESCE(SUM(oi.qty), 0) AS qty
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN products p ON p.id = oi.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE o.status NOT IN ('Dibatalkan', 'Batal', 'cancelled')
    GROUP BY COALESCE(c.name, 'Lainnya')
    ORDER BY qty DESC
  `);
  const totalQty = catRows.reduce((acc, r) => acc + Number(r.qty), 0);
  const categories = catRows.map((r) => ({
    name: r.name,
    percent: totalQty > 0 ? Math.round((Number(r.qty) / totalQty) * 100) : 0,
  }));

  // 4. Charm terlaris
  const [topRows] = await db.query(`
    SELECT COALESCE(p.name, oi.product_name) AS name, COALESCE(SUM(oi.qty), 0) AS sold
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE o.status NOT IN ('Dibatalkan', 'Batal', 'cancelled')
    GROUP BY COALESCE(p.id, 0), COALESCE(p.name, oi.product_name)
    ORDER BY sold DESC
    LIMIT 5
  `);
  const icons = ['★', 'XO', '⚑', '✿', '☾'];
  const topCharms = topRows.slice(0, 3).map((r, idx) => ({
    name: r.name,
    sold: Number(r.sold),
    icon: icons[idx] || r.name.slice(0, 2).toUpperCase(),
  }));

  const period = `${BULAN_FULL[now.getMonth()]} ${now.getFullYear()}`;
  res.json({
    period,
    dailyData,
    monthlyData,
    categories,
    topCharms,
    revenue7Days,
    bestSellers: topRows.map((r) => ({ label: r.name, value: Number(r.sold) })),
  });
});

module.exports = router;