// add-product.js
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// Grab arguments from the terminal: node add-product.js "Name" Price Stock
const args = process.argv.slice(2);
const name = args[0];
const price = parseFloat(args[1]);
const stock = parseInt(args[2], 10);

if (!name || isNaN(price) || isNaN(stock)) {
  console.log(" Please provide valid inputs!");
  console.log('Usage: node add-product.js "Product Name" Price Stock');
  console.log('Example: node add-product.js "Gaming Mouse" 49.99 100');
  process.exit(1);
}

async function addProduct() {
  try {
    const query = `INSERT INTO products (name, price, stock) VALUES ($1, $2, $3) RETURNING *;`;
    const values = [name, price, stock];

    const result = await pool.query(query, values);
    console.log(" Successfully added product to database:");
    console.log(result.rows[0]);
  } catch (err) {
    console.error(" Error inserting product:", err.message);
  } finally {
    await pool.end();
  }
}

addProduct();
