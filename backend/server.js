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

async function initDb() {
  const createTableQuery = `
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
      product_id INT REFERENCES products(id),
      quantity INT NOT NULL,
      price NUMERIC(10, 2) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  try {
    await pool.query(createTableQuery);
    await pool.query(createOrdersTable);
    console.log("Datbase tables 'products' and 'orders' created successfully");
  } catch (err) {
    console.error("Error creating tables:", err);
  }
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

    const productQuery = `SELECT stock FROM products WHERE id = $1 FOR UPDATE`;
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
    const totalPrice = product.price * quantity;

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
    const query = `SELECT orders.id AS order_id, orders.quantity, orders.total_price, orders.created_at AS order_date, products.id AS product_id, products.name AS product_name, products.price AS unit_price FROM orders JOIN products ON orders.product_id = products.id ORDER BY orders.created_at DESC`;
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

// A browser visit to http://localhost:5000/ requests GET /. Without this
// route Express has nothing to send and replies with its default "Cannot GET /".
app.get("/", (req, res) => {
  res.json({
    message: "Flash sale API is running",
    endpoints: {
      products: "/api/products",
      purchases: "/api/purchases",
      orders: "/api/orders",
      stats: "/api/stats",
    },
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  initDb();
});
