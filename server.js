import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

// Cache local (por término de búsqueda normalizado)
const cache = new Map();

// =========================
// PRUEBA BÁSICA DEL SERVIDOR
// =========================
app.get("/", (req, res) => {
  res.send("🚀 Roberta API funcionando con cache CDN y local");
});

// ---------- Utils ----------
const normalize = (str) =>
  (str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Levenshtein
function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const dp = Array.from({ length: al + 1 }, () => new Array(bl + 1));
  for (let i = 0; i <= al; i++) dp[i][0] = i;
  for (let j = 0; j <= bl; j++) dp[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[al][bl];
}

function similarToken(a, b) {
  // similitud token a token con tolerancia según longitud
  const d = levenshtein(a, b);
  const len = Math.max(a.length, b.length);
  if (len <= 4) return d <= 1;
  if (len <= 6) return d <= 1;
  if (len <= 10) return d <= 2;
  return d <= 3;
}

// Marcas conocidas (normalizadas -> canónica)
const KNOWN_BRANDS = new Map([
  ["kerastase", "Kérastase"],
  ["loreal professionnel", "L'Oréal Professionnel"],
  ["l oreal professionnel", "L'Oréal Professionnel"],
  ["loreal professional", "L'Oréal Professionnel"],
  ["alfaparf", "Alfaparf"],
  ["schwarzkopf", "Schwarzkopf"],
  ["igora", "Schwarzkopf"], // línea, vendor suele ser Schwarzkopf
  ["sebastian", "Sebastian Professional"],
  ["wella", "Wella Professionals"],
  ["redken", "Redken"],
  ["moroccanoil", "Moroccanoil"],
  ["revlon", "Revlon"],
  ["olaplex", "Olaplex"],
  ["fanola", "Fanola"],
  ["lakme", "Lakmé"],
  ["kevin murphy", "KEVIN.MURPHY"],
]);

function detectTargetBrand(queryTokens) {
  // Devuelve el nombre NORMALIZADO de la marca objetivo si se detecta
  let best = { brandNorm: null, score: -Infinity };
  const brandKeys = Array.from(KNOWN_BRANDS.keys());

  for (const bk of brandKeys) {
    const bkTokens = bk.split(" ");
    // score por coincidencias parciales o fuzzy entre tokens de query y tokens de la marca
    let s = 0;
    for (const q of queryTokens) {
      for (const bt of bkTokens) {
        if (q === bt) s += 3;
        else if (q.includes(bt) || bt.includes(q)) s += 2;
        else if (similarToken(q, bt)) s += 2;
      }
    }
    if (s > best.score) best = { brandNorm: bk, score: s };
  }
  // Umbral: si el score es suficiente, usamos esa marca
  return best.score >= 3 ? best.brandNorm : null;
}

function matchesProductFlexible(product, queryTokens) {
  const title = normalize(product.title);
  const vendor = normalize(product.vendor || "");
  const productType = normalize(product.productType || "");

  const candidateStrings = [title, vendor, productType].filter(Boolean);
  const candidateTokens = new Set(
    candidateStrings.flatMap((s) => s.split(" ").filter(Boolean))
  );

  return queryTokens.every((qTok) => {
    if (candidateStrings.some((s) => s.includes(qTok))) return true;
    for (const cTok of candidateTokens) {
      if (cTok.includes(qTok) || qTok.includes(cTok) || similarToken(cTok, qTok)) {
        return true;
      }
    }
    return false;
  });
}

// =========================
// ENDPOINT PRINCIPAL: /products
// =========================
app.get("/products", async (req, res) => {
  try {
    const rawQuery = req.query.q || "";
    if (!rawQuery) {
      return res.json({ message: "Por favor, incluye un parámetro ?q=" });
    }

    const queryNorm = normalize(rawQuery);
    const queryTokens = queryNorm.split(" ").filter(Boolean);

    // 0) Cache local (10 min) — clave incluye versión para invalidar si cambiamos lógica
    const cacheKey = `v3|${queryNorm}`;
    const cacheTTL = 10 * 60 * 1000;

    if (cache.has(cacheKey)) {
      const cached = cache.get(cacheKey);
      if (Date.now() - cached.timestamp < cacheTTL) {
        const etag = crypto.createHash("md5").update(cacheKey).digest("hex");
        res.setHeader("Cache-Control", "public, max-age=600, s-maxage=600");
        res.setHeader("ETag", `"${etag}"`);
        return res.json(cached.data);
      } else {
        cache.delete(cacheKey);
      }
    }

    // 1) Shopify: activos + publicados (luego filtramos stock)
    const graphqlQuery = {
      query: `
        {
          products(first: 100, query: "status:active published_status:published") {
            edges {
              node {
                id
                title
                handle
                vendor
                productType
                totalInventory
                featuredImage { url }
                variants(first: 10) {
                  edges {
                    node {
                      id
                      price
                      availableForSale
                      inventoryQuantity
                    }
                  }
                }
              }
            }
          }
        }
      `,
    };

    const response = await fetch(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2025-07/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(graphqlQuery),
      }
    );

    const data = await response.json();

    // 2) Stock disponible
    let products =
      data?.data?.products?.edges
        .map((e) => e.node)
        .filter(
          (p) =>
            p.totalInventory > 0 &&
            p.variants.edges.some(
              (v) => v.node.availableForSale && v.node.inventoryQuantity > 0
            )
        ) || [];

    // 3) Coincidencia flexible por texto
    products = products.filter((p) => matchesProductFlexible(p, queryTokens));

    // 4) Detección de marca objetivo (si la hay) y filtro prioritario
    const targetBrandNorm = detectTargetBrand(queryTokens);
    if (targetBrandNorm) {
      const brandCanon = KNOWN_BRANDS.get(targetBrandNorm); // canónica
      const brandFiltered = products.filter((p) => {
        const vend = normalize(p.vendor || "");
        // acepta si el vendor incluye la clave o si es similar al target
        return vend.includes(targetBrandNorm) || similarToken(vend, targetBrandNorm);
      });
      if (brandFiltered.length > 0) {
        products = brandFiltered;
      }
    }

    // 5) Ranking de relevancia (vendor > title > productType)
    const score = (p) => {
      const t = normalize(p.title);
      const v = normalize(p.vendor || "");
      const pt = normalize(p.productType || "");
      let s = 0;
      for (const q of queryTokens) {
        if (v.includes(q)) s += 4;                 // más peso a la marca
        if (t.includes(q)) s += 2;
        if (pt.includes(q)) s += 1;
        // pequeña bonificación si vendor ≈ brand detectada
        if (targetBrandNorm && (v.includes(targetBrandNorm) || similarToken(v, targetBrandNorm))) {
          s += 2;
        }
      }
      return -s; // sort asc -> mayor score primero
    };
    products = products.sort((a, b) => score(a) - score(b));

    // 6) Formato final (miniaturas 200x200 y add_to_cart)
    const formatted = products.map((p) => {
      let imageUrl = p.featuredImage?.url || null;
      if (imageUrl) {
        imageUrl = imageUrl.replace(/\.(png|jpe?g|webp)(\?.*)?$/, "_200x200.$1$2");
      }
      const firstVariant =
        p.variants.edges.find(
          (v) => v.node.availableForSale && v.node.inventoryQuantity > 0
        )?.node || p.variants.edges[0]?.node || {};
      const variantId = firstVariant.id ? firstVariant.id.split("/").pop() : null;

      return {
        id: p.id,
        variant_id: variantId,
        title: p.title,
        brand: p.vendor || "",
        category: p.productType || "",
        price: firstVariant.price || "N/A",
        image: imageUrl,
        url: `https://robertaonline.com/products/${p.handle}`,
        add_to_cart: variantId ? `https://robertaonline.com/cart/${variantId}:1` : null,
      };
    });

    // 7) Cache local + cabeceras CDN
    cache.set(cacheKey, { data: formatted, timestamp: Date.now() });
    const etag = crypto.createHash("md5").update(cacheKey).digest("hex");
    res.setHeader("Cache-Control", "public, max-age=600, s-maxage=600");
    res.setHeader("ETag", `"${etag}"`);

    res.json(formatted.length > 0 ? formatted : { message: "Sin resultados" });
  } catch (error) {
    console.error("Error buscando productos:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ==================================
// ENDPOINT: Crear pedido de prueba
// ==================================
app.post("/checkout/create", async (req, res) => {
  try {
    const order = {
      order: {
        line_items: [
          { title: "Pedido de prueba desde API", quantity: 1, price: "10.00" },
        ],
        email: "cliente@ejemplo.com",
        financial_status: "pending",
      },
    };

    const response = await fetch(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2025-07/orders.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(order),
      }
    );

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Error creando pedido:", error);
    res.status(500).json({ error: "Error interno al crear pedido" });
  }
});

// =========================
// INICIO DEL SERVIDOR
// =========================
app.listen(port, () => {
  console.log(`✅ Roberta API lista en http://localhost:${port}`);
});