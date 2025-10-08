import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

/* ----------------------- Utilidades de texto ----------------------- */
const normalize = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

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
const similarToken = (a, b) => {
  a = normalize(a); b = normalize(b);
  const d = levenshtein(a, b);
  const len = Math.max(a.length, b.length);
  if (len <= 4) return d <= 1;
  if (len <= 6) return d <= 1;
  if (len <= 10) return d <= 2;
  return d <= 3;
};

/* ---------------------- Detección de marcas ----------------------- */
/*  MAPA de marca normalizada -> candidatos de vendor en Shopify  */
const BRAND_VENDOR_CANDIDATES = {
  "kerastase": ["Kérastase", "KERASTASE", "KÉRASTASE", "Kerastase"],
  "loreal professionnel": ["L'Oréal Professionnel", "L'OREAL PROFESSIONNEL", "L'Oreal Professionnel", "LOREAL PROFESSIONNEL"],
  "redken": ["Redken", "REDKEN"],
  "schwarzkopf": ["Schwarzkopf", "SCHWARZKOPF"],
  "igora": ["IGORA", "Schwarzkopf"], // línea de Schwarzkopf
  "sebastian": ["Sebastian Professional", "SEBASTIAN", "Sebastian"],
  "alfaparf": ["Alfaparf", "ALFAPARF"],
  "moroccanoil": ["Moroccanoil", "MOROCCANOIL"],
  "olaplex": ["Olaplex", "OLAPLEX"],
  "revlon": ["Revlon", "REVLON"],
  "fanola": ["Fanola", "FANOLA"],
  "lakme": ["Lakmé", "LAKMÉ", "Lakme", "LAKME"],
};

function detectBrandKey(query) {
  const q = normalize(query);
  let best = { key: null, score: -Infinity };
  for (const key of Object.keys(BRAND_VENDOR_CANDIDATES)) {
    const toks = key.split(" ");
    let s = 0;
    for (const t of q.split(" ").filter(Boolean)) {
      for (const bt of toks) {
        if (t === bt) s += 3;
        else if (t.includes(bt) || bt.includes(t)) s += 2;
        else if (similarToken(t, bt)) s += 2;
      }
    }
    if (s > best.score) best = { key, score: s };
  }
  return best.score >= 2 ? best.key : null;
}

/* -------------------- Imagen miniatura 200x200 -------------------- */
function toThumb(url) {
  if (!url) return null;
  // Quita un sufijo de tamaño previo (_small/_medium/_large/_123x456) si existiera justo antes de la extensión
  const cleaned = url.replace(/(_\d+x\d+|_small|_medium|_large)?(\.(?:png|jpe?g|webp))(\?.*)?$/i, "$2$3");
  // Añade _200x200 antes de la extensión
  return cleaned.replace(/(\.(?:png|jpe?g|webp))(\?.*)?$/i, "_200x200$1$2");
}

/* ------------------- Filtros/score locales robustos ------------------- */
function hasStock(p) {
  const anyAvail = p.variants?.edges?.some(
    (e) => e?.node?.availableForSale && (e?.node?.inventoryQuantity ?? 1) > 0
  );
  return (p.totalInventory ?? 0) > 0 && anyAvail;
}

function matchesQuery(p, qNormTokens) {
  const blob = normalize(`${p.title} ${p.vendor} ${p.productType}`);
  const tokens = new Set(blob.split(" ").filter(Boolean));
  return qNormTokens.every((q) => {
    if (blob.includes(q)) return true;
    for (const t of tokens) {
      if (t.includes(q) || q.includes(t) || similarToken(t, q)) return true;
    }
    return false;
  });
}

function rankScore(p, qNormTokens, brandKey) {
  const title = normalize(p.title);
  const vendor = normalize(p.vendor || "");
  const ptype = normalize(p.productType || "");
  let s = 0;
  for (const q of qNormTokens) {
    if (vendor.includes(q)) s += 4;
    if (title.includes(q)) s += 2;
    if (ptype.includes(q)) s += 1;
  }
  if (brandKey) {
    const brandNorm = brandKey; // ya normalizado
    if (vendor.includes(brandNorm) || similarToken(vendor, brandNorm)) s += 3;
  }
  return -s; // sort asc
}

/* ------------------------ GraphQL helpers ------------------------ */
async function shopifyFetch(graphqlQuery) {
  const resp = await fetch(`https://${process.env.SHOPIFY_STORE}/admin/api/2025-07/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": process.env.SHOPIFY_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: graphqlQuery }),
  });
  const data = await resp.json();
  return data?.data?.products?.edges?.map((e) => e.node) || [];
}

/* --------------------------- Endpoints --------------------------- */

// Salud
app.get("/", (_req, res) => {
  res.send("🚀 Roberta API funcionando correctamente (fuzzy + miniaturas + stock)");
});

// Buscar productos
app.get("/products", async (req, res) => {
  try {
    const qRaw = (req.query.q || "").toString();
    if (!qRaw.trim()) {
      return res.json({ message: "Por favor, incluye un parámetro ?q=" });
    }
    const qNorm = normalize(qRaw);
    const qTokens = qNorm.split(" ").filter(Boolean);

    // 1) Intento dirigido por MARCA (si detectamos marca en la query)
    let products = [];
    const brandKey = detectBrandKey(qRaw);

    if (brandKey) {
      const candidates = BRAND_VENDOR_CANDIDATES[brandKey];
      // probamos varias grafías exactas de vendor en Shopify
      for (const cand of candidates) {
        // status:active + published_status:published + vendor exacto
        const vendorClause = `vendor:${cand.includes(" ") ? `"${cand}"` : cand}`;
        const gq = `
          {
            products(first: 100, query: "status:active published_status:published ${vendorClause}") {
              edges {
                node {
                  id title handle vendor productType status totalInventory
                  featuredImage { url }
                  variants(first: 10) { edges { node { id price availableForSale inventoryQuantity } } }
                }
              }
            }
          }
        `;
        const batch = await shopifyFetch(gq);
        products = products.concat(batch);
      }
      // de lo encontrado, nos quedamos con la misma marca (por si vinieron mezclas)
      if (products.length) {
        const brandFiltered = products.filter((p) => {
          const vend = normalize(p.vendor || "");
          return vend.includes(brandKey) || similarToken(vend, brandKey);
        });
        products = brandFiltered.length ? brandFiltered : products;
      }
    }

    // 2) Si no detectamos marca o no encontramos resultados, busca general
    if (!products.length) {
      const gq = `
        {
          products(first: 200, query: "status:active published_status:published") {
            edges {
              node {
                id title handle vendor productType status totalInventory
                featuredImage { url }
                variants(first: 10) { edges { node { id price availableForSale inventoryQuantity } } }
              }
            }
          }
        }
      `;
      products = await shopifyFetch(gq);
    }

    // 3) Filtrar por stock real
    products = products.filter(hasStock);

    // 4) Filtrado por coincidencia con la query del usuario (tolerante)
    products = products.filter((p) => matchesQuery(p, qTokens));

    // 5) Ordenar por relevancia (marca > título > tipo)
    products.sort((a, b) => rankScore(a, qTokens, brandKey) - rankScore(b, qTokens, brandKey));

    // 6) Formato final (miniaturas 200x200 + add_to_cart)
    const formatted = products.slice(0, 12).map((p) => {
      const firstVariant =
        p.variants?.edges?.find(
          (v) => v?.node?.availableForSale && (v?.node?.inventoryQuantity ?? 1) > 0
        )?.node || p.variants?.edges?.[0]?.node || null;

      const variantId = firstVariant?.id ? firstVariant.id.split("/").pop() : null;

      return {
        id: p.id,
        variant_id: variantId,
        title: p.title,
        brand: p.vendor || "",
        category: p.productType || "",
        price: firstVariant?.price || "N/A",
        image: toThumb(p.featuredImage?.url || null),
        url: `https://robertaonline.com/products/${p.handle}`,
        add_to_cart: variantId ? `https://robertaonline.com/cart/${variantId}:1` : null,
      };
    });

    return res.json(formatted.length ? formatted : { message: "Sin resultados" });
  } catch (err) {
    console.error("Error /products:", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

/* -------- (OPCIONAL) DEBUG rápido para ver vendors disponibles ------- */
// Útil si quieres validar cómo está escrito exactamente el vendor en Shopify.
// Comenta o borra este endpoint si no lo necesitas en producción.
app.get("/debug/vendors", async (_req, res) => {
  try {
    const gq = `
      {
        products(first: 200, query: "status:active published_status:published") {
          edges { node { vendor } }
        }
      }
    `;
    const products = await shopifyFetch(gq);
    const vendors = Array.from(new Set(products.map((p) => p.vendor).filter(Boolean))).sort();
    res.json({ vendors, count: vendors.length });
  } catch (e) {
    res.status(500).json({ error: "debug error" });
  }
});
// =========================
// DEBUG: Listar vendors activos
// =========================
app.get("/debug/vendors", async (_req, res) => {
  try {
    const gq = `
      {
        products(first: 100, query: "status:active published_status:published") {
          edges {
            node {
              vendor
            }
          }
        }
      }
    `;
    const resp = await fetch(`https://${process.env.SHOPIFY_STORE}/admin/api/2025-07/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: gq }),
    });
    const data = await resp.json();
    const vendors = Array.from(
      new Set(
        (data?.data?.products?.edges || [])
          .map((e) => e.node.vendor)
          .filter(Boolean)
      )
    ).sort();
    res.json({ vendors, count: vendors.length });
  } catch (err) {
    console.error("Error /debug/vendors:", err);
    res.status(500).json({ error: "Error interno" });
  }
});
/* ---------------------------- Boot ---------------------------- */
app.listen(port, () => {
  console.log(`✅ Roberta API lista en http://localhost:${port}`);
});