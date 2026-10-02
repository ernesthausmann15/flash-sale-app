// smart-add.js
import { spawn } from "node:child_process";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import pkg from "pg";
import dotenv from "dotenv";

/**
 * This machine's HTTPS traffic is signed by a local trust root that Node's
 * built-in CA list does not know. api.openai.com then fails with
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE, which the SDK reports only as
 * "Connection error." Restart once with the system certificate store.
 * The child process has the flag, so this runs a single time.
 */
if (!process.execArgv.includes("--use-system-ca")) {
  const child = spawn(
    process.execPath,
    ["--use-system-ca", ...process.argv.slice(1)],
    { stdio: "inherit", env: process.env },
  );
  child.on("exit", (code) => {
    process.exit(code ?? 1);
  });
} else {
  dotenv.config();
  run().catch((err) => {
    console.error(" Error processing command:", err.message);
    if (err.cause?.message) {
      console.error(" Cause:", err.cause.message);
    }
    process.exit(1);
  });
}

async function run() {

const { Pool } = pkg;

if (!process.env.OPENAI_API_KEY) {
  console.error(' Error: OPENAI_API_KEY is missing from your .env file or environment!');
  process.exit(1);
}

// Initialize clients
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// Define the exact schema the AI must extract
const ProductSchema = z.object({
  name: z.string(),
  description: z.string(),
  base_price: z.number(),
  stock: z.number().int(),
});

async function processManagerCommand(commandText) {
  try {
    console.log(` Manager Command Received: "${commandText}"`);

    // openai 7 removed beta.chat. parse() and zodResponseFormat now live on
    // the stable chat.completions client, which is what 7.25.0 actually exports.
    const completion = await openai.chat.completions.parse({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content:
            "You are an inventory assistant. Extract the product name, description, base price, and stock quantity from the manager statement.",
        },
        { role: "user", content: commandText },
      ],
      response_format: zodResponseFormat(ProductSchema, "product"),
    });

    
    const product = completion.choices[0].message.parsed;
    console.log(" AI Extracted Data:", product);

    // Securely write the parsed data into PostgreSQL
    const query = `INSERT INTO products (name, description, base_price, stock) VALUES ($1, $2, $3, $4) RETURNING *;`;
    const values = [product.name, product.description, product.base_price, product.stock];

    const result = await pool.query(query, values);
    console.log(" Successfully written to PostgreSQL database:");
    console.log(result.rows[0]);
  } finally {
    await pool.end();
  }
}

// Grab the sentence passed from your terminal
const userCommand = process.argv.slice(2).join(" ");
if (!userCommand) {
  console.log(" Please provide a command!");
  console.log(
    'Example: node smart-add.js "Hey, add 35 ergonomic desk chairs to inventory at 149.99 a piece."',
  );
  process.exit(1);
}

  await processManagerCommand(userCommand);
}
