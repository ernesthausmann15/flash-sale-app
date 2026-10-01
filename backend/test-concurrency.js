const BASE_URL = "http://localhost:5000/api";


async function runTest() {
  console.log("--- STARTING FLASH-SALE CONCURRENCY TEST ---");

  console.log("Creating flash-sale item with stock = 1...");
  const productRes = await fetch(`${BASE_URL}/products`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'Flash-Sale Item', price: 100, stock: 1 }),
  });
  const productData = await productRes.json();
  const productId = productData.product.id;
  console.log(`Flash-sale item created successfully! Product ID: ${productId}`);

  console.log("Starting concurrent purchases...Fires 10 simultaneous purchase requests...");
  const numConcurrentPurchases = 10;
  const purchasePromises = [];
  for (let i = 0; i < numConcurrentPurchases; i++) {
    const purchasePromise = fetch(`${BASE_URL}/purchases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ productId: productId, quantity: 1 }),
    }).then(async (res) => {
      const data = await res.json();
      return {user: i, status: res.status, data: data.success ? 'Success' : 'Failed'};
    }).catch((err) => {
      return {user: i, status: 500, data: err.message};
    });
    purchasePromises.push(purchasePromise);
  }
  const purchaseResults = await Promise.all(purchasePromises);
  
  let successCount = 0;
  let outOfStockCount = 0;


  console.log("\n--- TEST RESULTS ---");
  purchaseResults.forEach((result) => {
    if (result.status === 200) {
      successCount++;
      console.log(`User ${result.user} SUCCESS: Bout the item!`);
    } else if (result.status === 400) {
      outOfStockCount++;
      console.log(`User ${result.user} FAILED: Out of stock!`);
    }
  });

  console.log("\n--- SUMMARY ---");
  console.log(`Total users: ${numConcurrentPurchases}`);
  console.log(`Successful purchases: ${successCount} (Expected: exactly 1)`);
  console.log(`Failed purchases (out of stock): ${outOfStockCount} (Expected: exactly 9)`);
  console.log("\n--- END OF TEST ---");

  if (successCount === 1 && outOfStockCount === 9) {
    console.log(
      "CONCURRENCY TEST PASSED! Row-locking successfully prevented multiple purchases of the same item.",
    );
    return;
  }

  console.log(
    "CONCURRENCY TEST FAILED! Overselling occurred or request behaved unexpectedly.",
  );
  process.exitCode = 1;
}

runTest().catch((err) => {
  console.error("Error running test:", err);
});