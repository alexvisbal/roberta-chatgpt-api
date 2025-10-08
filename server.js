import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

// =========================
// TEST BÁSICO
// =========================
app.get("/", (req, res) => {
  res.send("🚀 Roberta API funcionando correctamente (fuzzy estable)");
});

// =========================
// ENDPOINT: Buscar productos con fuzzy matching estable
// =========================
app.get("/products", async (req, res) => {
  try {
    const query = req.query.q?.trim() || "";
    if (!query) {
      return res.json({ message: "Por favor, incluye un parámetro ?q=" });
    }

    // 🔹 Buscamos normalmente en Shopify (esto sí devuelve resultados)
    const graphqlQuery = {
      query: `
        {
          products(first: 100, query: "${query}") {
            edges {
              node {
                id
                title
                vendor
                handle
                status
                totalInventory
                featuredImage { url }
                variants(first: 5) {
                  edges {
                    node {
                      id
                      price
                      availableForSale
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
    const allProducts = data?.data?.products?.edges?.map((e) => e.node) || [];

    // 🔹 FILTRO: solo activos y con inventario > 0
    const filtered = allProducts.filter(
      (p) =>
        (p.status === "active" || p.status === "ACTIVE") &&
        p.totalInventory > 0
    );

    // 🔹 Si no hay resultados exactos, aplicamos fuzzy search local
    let results = filtered;
    if (results.length === 0) {
      const normalized = query.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      results = allProducts.filter((p) => {
        const text = `${p.title} ${p.vendor}`
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase();
        // tolerancia: coincidencia parcial de las primeras 3 letras
        return (
          text.includes(normalized) ||
          text.startsWith(normalized.slice(0, 3)) ||
          (normalized.length > 4 && text.includes(normalized.slice(0, 4)))
        );
      });
    }

    // 🔹 FORMATO FINAL (miniaturas + add to cart)
    const formatted = results.flatMap((p) => {
      const variant = p.variants.edges.find((v) => v.node.availableForSale);
      if (!variant) return [];
      const variantId = variant.node.id.split("/").pop();

      let imageUrl = p.featuredImage?.url || null;
      if (imageUrl) {
        imageUrl = imageUrl
          .replace(/\.png(\?.*)?$/, "_200x200.png$1")
          .replace(/\.jpg(\?.*)?$/, "_200x200.jpg$1")
          .replace(/\.jpeg(\?.*)?$/, "_200x200.jpeg$1")
          .replace(/\.webp(\?.*)?$/, "_200x200.webp$1");
      }

      return {
        id: p.id,
        title: p.title,
        brand: p.vendor || "Sin marca",
        price: variant.node.price || "N/A",
        image: imageUrl,
        url: `https://robertaonline.com/products/${p.handle}`,
        add_to_cart: `https://robertaonline.com/cart/${variantId}:1`,
      };
    });

    res.json(formatted.length > 0 ? formatted : { message: "Sin resultados" });
  } catch (error) {
    console.error("Error buscando productos:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// =========================
// INICIO DEL SERVIDOR
// =========================
app.listen(port, () => {
  console.log(`✅ Roberta API funcionando en http://localhost:${port}`);
});