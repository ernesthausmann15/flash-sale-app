"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
 * Express flash-sale API.
 * Next.js also wants port 3000, so the API runs on 5000 and this page calls that host.
 * Set NEXT_PUBLIC_API_URL if the API moves again.
 */
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5000";

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

export default function FlashSaleCatalog() {
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
      const response = await fetch(`${API_BASE}/api/purchases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: product.id,
          quantity: PURCHASE_QUANTITY,
        }),
      });

      const body = (await response.json().catch(() => null)) as
        | PurchaseResponse
        | null;
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

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
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
                          One unit per click. Sold-out replies stay on this card.
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
