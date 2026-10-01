"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * The sentence the form sends, and the two objects the API sends back.
 * extracted uses JavaScript numbers. dbRow.price is a string because
 * PostgreSQL NUMERIC is returned that way by node-pg.
 */
type ExtractedProduct = {
  name: string;
  price: number;
  stock: number;
};

type DbProductRow = {
  id: number;
  name: string;
  price: string;
  stock: number;
  created_at: string;
};

type AddProductResponse = {
  success: boolean;
  extracted?: ExtractedProduct;
  dbRow?: DbProductRow;
  error?: string;
};

/**
 * Express flash-sale API.
 * Next.js also wants port 3000, so the API runs on 5000 and this page calls that host.
 * Set NEXT_PUBLIC_API_URL if the API moves again.
 */
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** How many units a single "Buy Now" click reserves. The API still enforces stock. */
const PURCHASE_QUANTITY = 1;

/** At or below this count the badge switches from "in stock" to "low". */
const LOW_STOCK_THRESHOLD = 5;

type Product = {
  id: number;
  name: string;
  price: string | number;
  stock: number;
};

type ProductsResponse = {
  success: boolean;
  products?: Product[];
  error?: string;
};

type PurchaseResponse = {
  success: boolean;
  message?: string;
  error?: string;
  product?: { stock: number };
};

type NoticeTone = "success" | "sold-out" | "error";

type PurchaseNotice = {
  tone: NoticeTone;
  message: string;
};

function formatPrice(price: Product["price"]) {
  const amount = typeof price === "number" ? price : Number(price);
  if (Number.isNaN(amount)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

function stockLabel(stock: number) {
  if (stock <= 0) return "Sold out";
  if (stock <= LOW_STOCK_THRESHOLD) return `Low · ${stock} left`;
  return `${stock} in stock`;
}

function stockVariant(stock: number): "destructive" | "outline" | "secondary" {
  if (stock <= 0) return "destructive";
  if (stock <= LOW_STOCK_THRESHOLD) return "outline";
  return "secondary";
}

export default function FlashSaleInventoryManagerPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [catalogState, setCatalogState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [catalogError, setCatalogError] = useState<string | null>(null);

  /**
   * Product ids whose purchase request is on the wire.
   * A ref blocks a second click before React re-renders; state is what the
   * button reads so the spinner and disabled styles appear immediately.
   */
  const inFlightIds = useRef<Set<number>>(new Set());
  const [purchasingIds, setPurchasingIds] = useState<Set<number>>(new Set());
  const [notices, setNotices] = useState<Record<number, PurchaseNotice>>({});
  const [command, setCommand] = useState(
    "Add 25 gaming monitors at 299.99 each",
  );
  const [commandPending, setCommandPending] = useState(false);
  const [commandResult, setCommandResult] = useState<AddProductResponse | null>(
    null,
  );

  const loadProducts = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`${API_BASE}/api/products`, {
      signal,
      cache: "no-store",
    });
    const body = (await response.json()) as ProductsResponse;

    if (!response.ok || !body.success || !body.products) {
      throw new Error(body.error ?? "Could not load the catalog.");
    }

    return body.products.map((product) => ({
      ...product,
      id: Number(product.id),
      stock: Number(product.stock),
    }));
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    loadProducts(controller.signal)
      .then((nextProducts) => {
        setProducts(nextProducts);
        setCatalogState("ready");
        setCatalogError(null);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setCatalogState("error");
        setCatalogError(
          error instanceof Error
            ? error.message
            : "Could not reach the flash-sale API.",
        );
      });

    return () => controller.abort();
  }, [loadProducts]);

  async function submitCommand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const commandText = command.trim();
    if (!commandText || commandPending) return;

    setCommandPending(true);
    setCommandResult(null);

    try {
      // Same host as the catalog. backend/.env sets PORT=5000, so the
      // form must not call a hardcoded port 4000.
      const response = await fetch(`${API_BASE}/api/add-product`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandText }),
      });
      const data = (await response.json()) as AddProductResponse;
      setCommandResult(data);

      if (response.ok && data.success) {
        const fresh = await loadProducts();
        setProducts(fresh);
        setCatalogState("ready");
        setCatalogError(null);
      }
    } catch (error: unknown) {
      setCommandResult({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "The command never reached the API.",
      });
    } finally {
      setCommandPending(false);
    }
  }

  function syncPurchasing() {
    setPurchasingIds(new Set(inFlightIds.current));
  }

  async function buyNow(product: Product) {
    if (product.stock <= 0 || inFlightIds.current.has(product.id)) {
      return;
    }

    inFlightIds.current.add(product.id);
    syncPurchasing();
    setNotices((current) => {
      const next = { ...current };
      delete next[product.id];
      return next;
    });

    try {
      // Wrap your fetch and the 600ms timer together using Promise.all
      const [response] = await Promise.all([
        fetch(`${API_BASE}/api/purchases`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            productId: product.id,
            quantity: PURCHASE_QUANTITY,
          }),
        }),
        new Promise((resolve) => setTimeout(resolve, 600)), // Minimum 600ms delay for the loader
      ]);

      const body = (await response
        .json()
        .catch(() => null)) as PurchaseResponse | null;
      const message = body?.error ?? body?.message ?? "Purchase failed.";
      const soldOut = response.status === 400 && /out of stock/i.test(message);

      if (!response.ok || !body?.success) {
        setNotices((current) => ({
          ...current,
          [product.id]: {
            tone: soldOut ? "sold-out" : "error",
            message,
          },
        }));
        // Another shopper may have taken the last units. Reload so the badge matches the database.
        const fresh = await loadProducts();
        setProducts(fresh);
        return;
      }

      const nextStock = body.product?.stock;
      setProducts((current) =>
        current.map((item) =>
          item.id === product.id
            ? {
                ...item,
                stock:
                  typeof nextStock === "number"
                    ? nextStock
                    : Math.max(0, item.stock - PURCHASE_QUANTITY),
              }
            : item,
        ),
      );
      setNotices((current) => ({
        ...current,
        [product.id]: {
          tone: "success",
          message: body.message ?? "Purchase successful.",
        },
      }));
    } catch {
      setNotices((current) => ({
        ...current,
        [product.id]: {
          tone: "error",
          message: "The purchase request never reached the server.",
        },
      }));
    } finally {
      inFlightIds.current.delete(product.id);
      syncPurchasing();
    }
  }

  return (
    <div className="flex flex-1 flex-col bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-8 sm:px-6">
          <p className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
            Live catalog
          </p>
          <h1 className="font-heading text-3xl font-semibold tracking-tight">
            Flash sale
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Stock is reserved on the server, one purchase at a time. The button
            locks the moment you click so a double-click cannot send two orders.
          </p>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
        <Card>
          <CardHeader>
            <CardTitle>Add with a sentence</CardTitle>
            <CardDescription>
              The form posts <span className="font-mono">commandText</span>. The
              API replies with extracted numbers and the database row.
            </CardDescription>
          </CardHeader>
          <form onSubmit={submitCommand}>
            <CardContent className="flex flex-col gap-3">
              <label
                htmlFor="inventory-command"
                className="text-xs font-medium tracking-wide text-muted-foreground uppercase"
              >
                Natural language command
              </label>
              <input
                id="inventory-command"
                type="text"
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                className="h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                placeholder="Add 10 mechanical keyboards at 120.00 each"
              />
            </CardContent>
            <CardFooter className="flex flex-col items-stretch gap-3">
              <Button
                type="submit"
                disabled={commandPending || !command.trim()}
              >
                {commandPending ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Reading the sentence
                  </>
                ) : (
                  "Add to inventory"
                )}
              </Button>
              {commandResult ? (
                <div className="w-full">
                  <p
                    role="status"
                    className={
                      commandResult.success
                        ? "text-sm text-foreground"
                        : "text-sm text-destructive"
                    }
                  >
                    {commandResult.success
                      ? `Added ${commandResult.extracted?.name ?? "product"} at ${commandResult.extracted?.price ?? "—"} with stock ${commandResult.extracted?.stock ?? "—"}.`
                      : commandResult.error}
                  </p>
                  <pre className="mt-2 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs text-foreground">
                    {JSON.stringify(commandResult, null, 2)}
                  </pre>
                </div>
              ) : null}
            </CardFooter>
          </form>
        </Card>

        {catalogState === "loading" ? <CatalogSkeleton /> : null}

        {catalogState === "error" ? (
          <Card>
            <CardHeader>
              <CardTitle>Catalog unavailable</CardTitle>
              <CardDescription>
                {catalogError} The page is calling {API_BASE}/api/products.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : null}

        {catalogState === "ready" && products.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>No products yet</CardTitle>
              <CardDescription>
                The sale opens once products are added to the catalog.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : null}

        {catalogState === "ready" && products.length > 0 ? (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {products.map((product) => {
              const purchasing = purchasingIds.has(product.id);
              const soldOut = product.stock <= 0;
              const notice = notices[product.id];

              return (
                <li key={product.id}>
                  <Card className="h-full">
                    <CardHeader>
                      <CardTitle>{product.name}</CardTitle>
                      <CardDescription className="font-mono text-base text-foreground">
                        {formatPrice(product.price)}
                      </CardDescription>
                      <div className="pt-2">
                        <Badge variant={stockVariant(product.stock)}>
                          {stockLabel(product.stock)}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent>
                      {notice ? (
                        <p
                          role="status"
                          className={
                            notice.tone === "success"
                              ? "text-sm text-foreground"
                              : "text-sm text-destructive"
                          }
                        >
                          {notice.message}
                        </p>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          One unit per click. Sold-out replies stay on this
                          card.
                        </p>
                      )}
                    </CardContent>
                    <CardFooter>
                      <Button
                        type="button"
                        className="w-full"
                        disabled={soldOut || purchasing}
                        aria-busy={purchasing}
                        onClick={() => {
                          void buyNow(product);
                        }}
                      >
                        {purchasing ? (
                          <>
                            <Loader2 className="animate-spin" />
                            Reserving
                          </>
                        ) : soldOut ? (
                          "Sold out"
                        ) : (
                          "Buy now"
                        )}
                      </Button>
                    </CardFooter>
                  </Card>
                </li>
              );
            })}
          </ul>
        ) : null}
      </main>
    </div>
  );
}

function CatalogSkeleton() {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 3 }, (_, index) => (
        <li key={index}>
          <Card>
            <CardHeader>
              <div className="h-5 w-2/3 animate-pulse rounded-md bg-muted" />
              <div className="h-4 w-1/3 animate-pulse rounded-md bg-muted" />
            </CardHeader>
            <CardContent>
              <div className="h-4 w-full animate-pulse rounded-md bg-muted" />
            </CardContent>
            <CardFooter>
              <div className="h-8 w-full animate-pulse rounded-lg bg-muted" />
            </CardFooter>
          </Card>
        </li>
      ))}
    </ul>
  );
}
