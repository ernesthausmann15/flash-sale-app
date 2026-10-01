import express from "express";
import pkg from "pg";
const { Pool } = pkg;
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

/**
 * Ensure the tables the purchase route writes actually exist.
 *
 * CREATE TABLE IF NOT EXISTS does nothing when a table of that name is already
 * there, even if its columns are from an older design. This database already
 * had an `orders` table of user_id / item_id / status, so the INSERT that
 * names product_id failed on every Buy click. We only replace that table when
 * it is empty, so a restart cannot throw away real orders.
 */
async function initDb() {
  const createProductsTable = `
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      price NUMERIC(10, 2) NOT NULL,
      stock INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const createOrdersTable = `
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      product_id INT NOT NULL REFERENCES products(id),
      quantity INT NOT NULL,
      price NUMERIC(10, 2) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  await pool.query(createProductsTable);

  const columns = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'orders'`,
  );
  const columnNames = columns.rows.map((row) => row.column_name);
  const ordersExist = columnNames.length > 0;
  const ordersMatchPurchaseRoute =
    columnNames.includes("product_id") && columnNames.includes("price");

  if (ordersExist && !ordersMatchPurchaseRoute) {
    const count = await pool.query("SELECT COUNT(*)::int AS count FROM orders");
    if (count.rows[0].count > 0) {
      throw new Error(
        "orders table is missing product_id/price and already has rows, so it was left unchanged",
      );
    }
    await pool.query("DROP TABLE orders");
    console.log(
      "Dropped empty orders table whose columns did not match the purchase route",
    );
  }

  await pool.query(createOrdersTable);
  console.log("Database tables 'products' and 'orders' are ready");
}

app.get("/api/test-db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({
      message: "Database connection successful",
      timestamp: result.rows[0].now,
    });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Database connection failed", error: err.message });
  }
});

app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM products ORDER BY id ASC");
    res.json({
      success: true,
      count: result.rows.length,
      products: result.rows,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/products", async (req, res) => {
  const { name, price, stock } = req.body;

  if (!name || typeof name !== "string" || name.trim() === "") {
    return res.status(400).json({ success: false, error: "Name is required" });
  }
  if (!price || typeof price !== "number" || price <= 0) {
    return res.status(400).json({ success: false, error: "Price is required" });
  }
  if (!stock || typeof stock !== "number" || stock < 0) {
    return res.status(400).json({ success: false, error: "Stock is required" });
  }

  try {
    const query = `INSERT INTO products (name, price, stock) VALUES ($1, $2, $3) RETURNING *`;
    const values = [name, price, stock];
    const result = await pool.query(query, values);
    res.json({ success: true, product: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/purchases", async (req, res) => {
  const { productId, quantity } = req.body;

  if (!productId || !Number.isInteger(productId) || productId <= 0) {
    return res
      .status(400)
      .json({ success: false, error: "Product ID is required" });
  }
  if (!quantity || !Number.isInteger(quantity) || quantity <= 0) {
    return res
      .status(400)
      .json({ success: false, error: "Quantity must be a positive integer" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const productQuery = `SELECT stock, price FROM products WHERE id = $1 FOR UPDATE`;
    const productResult = await client.query(productQuery, [productId]);

    if (productResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, error: "Product not found" });
    }

    const product = productResult.rows[0];

    if (product.stock < quantity) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        error: `Out of stock! Only ${product.stock} items remaining`,
      });
    }

    const newStock = product.stock - quantity;
    // node-pg returns NUMERIC as a string. Coerce before multiplying so the
    // order stores 49.99, not a concatenated string.
    const totalPrice = Number(product.price) * quantity;

    const updateStockQuery = `UPDATE products SET stock = $1 WHERE id = $2 RETURNING stock`;
    const updateResult = await client.query(updateStockQuery, [
      newStock,
      productId,
    ]);

    const orderQuery = `INSERT INTO orders (product_id, quantity, price) VALUES ($1, $2, $3) RETURNING *`;
    const orderResult = await client.query(orderQuery, [
      productId,
      quantity,
      totalPrice,
    ]);

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Purchase successful",
      order: orderResult.rows[0],
      product: updateResult.rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

app.get("/api/orders", async (req, res) => {
  try {
    // The charged amount lives in orders.price. Alias it so the response
    // still exposes the line total under a clear name.
    const query = `SELECT orders.id AS order_id, orders.quantity, orders.price AS total_price, orders.created_at AS order_date, products.id AS product_id, products.name AS product_name, products.price AS unit_price FROM orders JOIN products ON orders.product_id = products.id ORDER BY orders.created_at DESC`;
    const result = await pool.query(query);
    res.json({
      success: true,
      count: result.rows.length,
      orders: result.rows,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/orders/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const query = `DELETE FROM orders WHERE id = $1`;
    const result = await pool.query(query, [id]);
    res.json({ success: true, message: "Order deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/stats", async (req, res) => {
  try {
    const query = `SELECT SUM(quantity) AS total_quantity, SUM(price) AS total_revenue FROM orders`;
    const result = await pool.query(query);
    res.json({
      success: true,
      total_quantity: result.rows[0].total_quantity,
      total_revenue: result.rows[0].total_revenue,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/stats/product/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const query = `SELECT SUM(quantity) AS total_quantity, SUM(price) AS total_revenue FROM orders WHERE product_id = $1`;
    const result = await pool.query(query, [id]);
    res.json({
      success: true,
      total_quantity: result.rows[0].total_quantity,
      total_revenue: result.rows[0].total_revenue,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 5000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Database setup failed:", err);
    process.exit(1);
  });
