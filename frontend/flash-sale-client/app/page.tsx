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
 * Set NEXT_PUBLIC_BACKEND_URL if the API moves again.
 */
const API_BASE = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

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
  const [purchaseHistory, setPurchaseHistory] = useState<
    {
      flashSaleId: number;
      quantity: number;
      success: boolean;
      message: string;
      error: string;
    }[]
  >([]);
  const [flashSalePurchaseResult, setFlashSalePurchaseResult] =
    useState<PurchaseResponse | null>(null);
  const [flashSalePurchasePending, setFlashSalePurchasePending] =
    useState(false);
  const [flashSalePurchaseError, setFlashSalePurchaseError] = useState<
    string | null
  >(null);
  const [flashSalePurchaseMessage, setFlashSalePurchaseMessage] = useState<
    string | null
  >(null);
  const [flashSalePurchaseSuccess, setFlashSalePurchaseSuccess] = useState<
    boolean | null
  >(null);
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

  const inventoryCommand = useCallback(async (commandText: string) => {
    const response = await fetch(`${API_BASE}/api/add-product`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandText }),
    });
    const data = (await response.json()) as AddProductResponse;
    return data;
  }, []);

  const purchase = useCallback(
    async (flashSaleId: number, quantity: number) => {
      const response = await fetch(`${API_BASE}/api/purchase-flash-sale`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flashSaleId, quantity }),
      });
      const data = (await response.json()) as PurchaseResponse;
      return data;
    },
    [],
  );

  const showInventoryCommandResult = useCallback(async () => {
    try {
      const result = await inventoryCommand(command);
      if (result.success) {
        const fresh = await loadProducts();
        setProducts(fresh);
        setCatalogState("ready");
        setCatalogError(null);
      }
      setCommandResult(result);
    } catch (error: unknown) {
      setCatalogError(
        error instanceof Error
          ? error.message
          : "The command never reached the API.",
      );
    }
  }, [
    command,
    loadProducts,
    setProducts,
    setCatalogState,
    setCatalogError,
    setCommandResult,
  ]);

  const syncFlashSalePurchasing = useCallback(
    async (flashSaleId: number) => {
      setPurchasingIds(new Set([...purchasingIds, flashSaleId]));
    },
    [purchasingIds, setPurchasingIds],
  );

  const syncPurchasing = useCallback(async () => {
    setPurchasingIds(new Set(inFlightIds.current));
  }, [inFlightIds.current, setPurchasingIds]);

  const submitInventoryCommand = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
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
    },
    [
      commandPending,
      command,
      loadProducts,
      setProducts,
      setCatalogState,
      setCatalogError,
      setCommandResult,
    ],
  );

  const submitFlashSalePurchase = useCallback(
    async (flashSaleId: number, quantity: number) => {
      if (!flashSaleId || flashSalePurchasePending) return;

      setFlashSalePurchaseResult(null);
      setPurchaseHistory([
        ...purchaseHistory,
        { flashSaleId, quantity, success: false, message: "", error: "" },
      ]);

      try {
        const response = await fetch(`${API_BASE}/api/purchase-flash-sale`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flashSaleId, quantity }),
        });
        const data = (await response.json()) as PurchaseResponse;
        setPurchaseHistory([
          ...purchaseHistory,
          {
            flashSaleId,
            quantity,
            success: data.success,
            message: data.message ?? "",
            error: data.error ?? "",
          },
        ]);

        if (response.ok && data.success) {
          const fresh = await loadProducts();
          setProducts(fresh);
          setCatalogState("ready");
          setCatalogError(null);
        }
      } catch (error: unknown) {
        setPurchaseHistory([
          ...purchaseHistory,
          {
            flashSaleId,
            quantity,
            success: false,
            message: "",
            error:
              error instanceof Error
                ? error.message
                : "The purchase request never reached the server.",
          },
        ]);
        setFlashSalePurchaseError(
          error instanceof Error
            ? error.message
            : "The purchase request never reached the server.",
        );
        setFlashSalePurchaseMessage(null);
        setFlashSalePurchaseSuccess(false);
      } finally {
        setFlashSalePurchasePending(false);
      }
    },
    [
      flashSalePurchasePending,
      purchaseHistory,
      loadProducts,
      setProducts,
      setCatalogState,
      setCatalogError,
      setPurchaseHistory,
      setFlashSalePurchaseError,
      setFlashSalePurchaseMessage,
      setFlashSalePurchaseSuccess,
    ],
  );
  return (
    <main className="min-h-screen bg-background p-6 md:p-10">
      <div className="mx-auto max-w-6xl space-y-8">
        
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Flash Sale Command Center</h1>
          <p className="text-muted-foreground">Manage your live inventory and process flash sale checkouts.</p>
        </div>

        {/* Grid Layout for Cards */}
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          
          {/* Card 1: Flash Sale Purchase Form */}
          <Card>
            <CardHeader>
              <CardTitle>Instant Purchase</CardTitle>
              <CardDescription>Secure your spot in the active flash sale.</CardDescription>
            </CardHeader>
            <CardContent>
              </CardContent>
          </Card>

          {/* Card 2: Inventory Command Tool */}
          <Card>
            <CardHeader>
              <CardTitle>Inventory Command</CardTitle>
              <CardDescription>Quick-add products using natural language commands.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <input 
                type="text" 
                value={command} 
                onChange={(e) => setCommand(e.target.value)} 
                placeholder="e.g., Add 50 mechanical keyboards for $99"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
              <Button 
                onClick={showInventoryCommandResult}
                disabled={commandPending}
                className="w-full"
              >
                {commandPending ? "Processing..." : "Run Command"}
              </Button>
            </CardContent>
          </Card>

        </div>

        {/* Card 3: Product Catalog Full-Width Section */}
        <Card>
          <CardHeader>
            <CardTitle>Live Product Catalog</CardTitle>
            <CardDescription>Currently available inventory synced from Supabase.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="border rounded-md p-4 bg-muted/20 min-h-[150px] flex items-center justify-center text-muted-foreground">
              [Product catalog grid will display here]
            </div>
          </CardContent>
        </Card>

      </div>
    </main>
  );
};

function PurchaseHistory({
  purchaseHistory,
  submitFlashSalePurchase,
}: {
  purchaseHistory: {
    flashSaleId: number;
    quantity: number;
    success: boolean;
    message: string;
    error: string;
  }[];
  submitFlashSalePurchase: (flashSaleId: number) => Promise<void>;
}) {
  return (
    <ul className="space-y-4">
      {purchaseHistory.map(
        (purchase: {
          flashSaleId: number;
          quantity: number;
          success: boolean;
          message: string;
          error: string;
        }) => (
          <li key={purchase.flashSaleId}>
            <Card className="h-full">
              <CardHeader>
                <CardTitle>{purchase.flashSaleId}</CardTitle>
                <CardDescription className="font-mono text-base text-foreground">
                  {purchase.quantity}
                </CardDescription>
                <div className="pt-2">
                  <Badge variant={purchase.success ? "default" : "destructive"}>
                    {purchase.success ? "Success" : "Error"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>{purchase.message}</CardContent>
              <CardFooter>
                <Button
                  type="button"
                  className="w-full"
                  disabled={purchase.success}
                  aria-busy={purchase.success}
                  onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                    e.preventDefault();
                    void submitFlashSalePurchase(purchase.flashSaleId);
                  }}
                >
                  {purchase.success ? "Reserve again" : "Reserve"}
                </Button>
              </CardFooter>
            </Card>
          </li>
        ),
      )}
    </ul>
  );
}
