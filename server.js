import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

// =========================
// PRUEBA BÁSICA DEL SERVIDOR
// =========================
app.get("/", (req, res) => {
  res.send("🚀 Roberta API funcionando correctamente");
});

// ---------- Utils de búsqueda flexible ----------
const normalize = (str) =>
  (str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quita acentos
    .replace(/[^a-z0-9\s]/g, " ") // limpia signos
    .replace(/\s+/g, " ") // colapsa espacios
    .trim();

// Distancia de Levenshtein (tolerancia a errores tipográficos)
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
        dp[i - 1][j] + 1,      // borrado
        dp[i][j - 1] + 1,      // inserción
        dp[i - 1][j - 1] + cost // sustitución
      );
    }
  }
  return dp[al][bl];
}

// Regla de similitud por longitud (tolerancia escalada)
function similar(a, b) {
  const d = levenshtein(a, b);
  const len = Math.max(a.length, b.length);
  if (len <= 4) return d === 0;      // muy cortas: exacto
  if (len <= 6) return d <= 1;       // pequeñas: 1 error
  if (len <= 10) return d <= 2;      // medianas: 2 errores
  return d <= 3;                     // largas: hasta 3 errores
}

// ¿El producto coincide con TODOS los tokens de la consulta (en cualquiera de sus tokens)?
function matchesProduct(product, queryTokens) {
  const title = normalize(product.title);
  const vendor = normalize(product.vendor || "");
  const productType = normalize(product.productType || "");

  const candidateStrings = [title, vendor, productType].filter(Boolean);
  const candidateTokens = new Set(
    candidateStrings.flatMap((s) => s.split(" ").filter(Boolean))
  );

  // Para cada token de la query, debe existir algún token candidato que coincida (includes o similar)
  return queryTokens.every((qTok) => {
    // también permitimos includes contra el string completo (títulos largos)
    if (candidateStrings.some((s) => s.includes(qTok))) return true;

    // si no, probamos similitud token a token
    for (const cTok of candidateTokens) {
      if (cTok.includes(qTok) || qTok.includes(cTok) || similar(cTok, qTok)) {
        return true;
      }
    }
    return false;
  });
}

// =========================
//// ENDPOINT: Buscar productos (GraphQL) con búsqueda flexible
// =========================
app.get("/products", async (req, res) => {
  try {
    const rawQuery = req.query.q || "";
    if (!rawQuery) {
      return res.json({ message: "Por favor, incluye un parámetro ?q=" });
    }

    const queryNorm = normalize(rawQuery);
    const queryTokens = queryNorm.split(" ").filter(Boolean);

    // --- Pedimos productos activos/publicados; filtramos stock y similitud en Node ---
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
                variants(first: 5) {
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

    // --- 1) Solo activos + publicados + con stock ---
    let products =
      data?.data?.products?.edges
        .map((edge) => edge.node)
        .filter(
          (p) =>
            p.totalInventory > 0 &&
            p.variants.edges.some(
              (v) => v.node.availableForSale && v.node.inventoryQuantity > 0
            )
        ) || [];

    // --- 2) Coincidencia flexible por tokens (tolerante a errores) ---
    products = products.filter((p) => matchesProduct(p, queryTokens));

    // --- 3) Ranking simple (prioriza coincidencia en vendor, luego título, luego tipo) ---
    const score = (p) => {
      const t = normalize(p.title);
      const v = normalize(p.vendor || "");
      const pt = normalize(p.productType || "");
      let s = 0;
      for (const q of queryTokens) {
        if (v.includes(q)) s += 3;
        if (t.includes(q)) s += 2;
        if (pt.includes(q)) s += 1;
      }
      return -s; // sort asc => mayor score primero
    };
    products = products.sort((a, b) => score(a) - score(b));

    // --- 4) Formato final (miniaturas + add_to_cart) ---
    const formatted = products.map((p) => {
      let imageUrl = p.featuredImage?.url || null;
      if (imageUrl) {
        imageUrl = imageUrl
          .replace(/\.png(\?.*)?$/, "_medium.png$1")
          .replace(/\.jpg(\?.*)?$/, "_medium.jpg$1")
          .replace(/\.jpeg(\?.*)?$/, "_medium.jpeg$1")
          .replace(/\.webp(\?.*)?$/, "_medium.webp$1");
      }

      // elegimos la primera variante disponible
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
        add_to_cart: variantId
          ? `https://robertaonline.com/cart/${variantId}:1`
          : null,
      };
    });

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
          {
            title: "Pedido de prueba desde API",
            quantity: 1,
            price: "10.00",
          },
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
  console.log(`✅ Roberta API funcionando en http://localhost:${port}`);
});