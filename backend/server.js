import express from "express";
import pkg from "pg";
const { Pool } = pkg;
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// If this is undefined, throw an error right away instead of falling back to localhost
if (!process.env.DATABASE_URL) {
  throw new Error("FATAL ERROR: DATABASE_URL environment variable is missing!");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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
    // NUMERIC arrives from node-pg as a string. Multiply the number so the
    // order row stores 120.00, not a concatenation.
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

// The form sends this shape, and OpenAI must return the same three fields
// the products table stores. stock is an integer because the column is INT.
const ProductCommandSchema = z.object({
  name: z.string(),
  price: z.number(),
  stock: z.number().int(),
});

/**
 * Natural-language inventory command.
 * Request:  { commandText: string }
 * Response: { success: true, extracted: { name, price, stock }, dbRow }
 *           or { success: false, error }
 *
 * openai 7 moved structured parsing off beta.chat and onto
 * chat.completions.parse. zodResponseFormat still builds the JSON schema.
 */
app.post("/api/add-product", async (req, res) => {
  const commandText = req.body?.commandText;

  if (typeof commandText !== "string" || commandText.trim() === "") {
    return res
      .status(400)
      .json({ success: false, error: "commandText is required" });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res
      .status(500)
      .json({ success: false, error: "OPENAI_API_KEY is missing" });
  }

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.parse({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content:
            "You are an inventory assistant. Extract the product name, unit price, and stock quantity from the manager statement.",
        },
        { role: "user", content: commandText.trim() },
      ],
      response_format: zodResponseFormat(ProductCommandSchema, "product"),
    });

    const extracted = completion.choices[0]?.message.parsed;
    if (!extracted) {
      return res.status(422).json({
        success: false,
        error: "The model did not return a product.",
      });
    }

    const name = extracted.name.trim();
    const price = extracted.price;
    const stock = extracted.stock;
    if (!name || !Number.isFinite(price) || price <= 0 || stock < 0) {
      return res.status(422).json({
        success: false,
        error: "Extracted product was incomplete.",
      });
    }

    const inserted = await pool.query(
      `INSERT INTO products (name, price, stock) VALUES ($1, $2, $3) RETURNING *`,
      [name, price, stock],
    );

    res.json({
      success: true,
      extracted: { name, price, stock },
      dbRow: inserted.rows[0],
    });
  } catch (err) {
    const cause = err.cause?.message ? ` ${err.cause.message}` : "";
    res.status(500).json({
      success: false,
      error: `${err.message}${cause}`,
    });
  }
});

// A browser visit to http://localhost:5000/ requests GET /. Without this
// route Express has nothing to send and replies with its default "Cannot GET /".
app.get("/", (req, res) => {
  res.json({
    message: "Flash sale API is running",
    endpoints: {
      products: "/api/products",
      addProduct: "/api/add-product",
      purchases: "/api/purchases",
      orders: "/api/orders",
      stats: "/api/stats",
    },
  });
});

// 1. Health check route to test Supabase connection live
app.get("/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({
      status: "success",
      message: "Connected to Supabase successfully!",
      databaseTime: result.rows[0].now,
    });
  } catch (err) {
    console.error("Database connection error:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  initDb();
});
